/**
 * functions/api/reservations.js
 * -----------------------------------------------------------------------
 * POST /api/reservations
 * Creates a dine-in reservation. It can be submitted by a signed-in
 * customer or as a guest. If the customer is signed in, the booking is
 * linked to their account so the cafe can follow up later.
 *
 * GET /api/reservations
 * Returns the reservations for the currently signed-in customer.
 * -----------------------------------------------------------------------
 */
import { runQuery, jsonResponse } from "../_lib/db.js";
import {
  requireCustomer,
  ensureCustomerProfileColumns,
} from "../_lib/customerAuth.js";
import { sanitizeText, getRequestIp } from "../_lib/security.js";
import { logAudit } from "../_lib/audit.js";
import { validateReservationSlot } from "../_lib/hours.js";
import { queuePush } from "../_lib/push.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const { customer, error } = await requireCustomer(request, env);
  if (error) return error;

  try {
    const result = await runQuery(
      env,
      `
      SELECT r.id, r.customer_name, r.customer_phone,
             to_char(r.reservation_date, 'YYYY-MM-DD') AS reservation_date,
             to_char(r.reservation_time, 'HH24:MI') AS reservation_time,
             r.party_size, r.table_number, r.notes,
             r.advance_order_requested, r.advance_order_details, r.advance_order_id, r.status, r.created_at,
             o.payment_status AS preorder_payment_status, o.total_amount AS preorder_total
      FROM customer_reservations r
      LEFT JOIN orders o ON o.id = r.advance_order_id
      WHERE r.customer_id = $1
      ORDER BY r.reservation_date DESC, r.reservation_time DESC;
    `,
      [customer.id],
    );

    return jsonResponse({ reservations: result.rows });
  } catch (err) {
    return jsonResponse(
      { error: "Failed to load your reservations.", message: err.message },
      500,
    );
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const requestIp = getRequestIp(request);
  const { customer } = await requireCustomer(request, env).catch(() => ({
    customer: null,
  }));
  await ensureCustomerProfileColumns(env);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body." }, 400);
  }

  const name = sanitizeText(body.name || "", 100);
  const email = sanitizeText(body.email || "", 100).toLowerCase();
  const phone = sanitizeText(body.phone || "", 50);
  const reservationDate = sanitizeText(body.reservation_date || "", 30);
  const reservationTime = sanitizeText(body.reservation_time || "", 30);
  const partySize = parseInt(body.party_size || body.partySize, 10);
  const tableNumber = sanitizeText(
    body.table_number || body.tableNumber || "",
    30,
  );
  const notes = sanitizeText(body.notes || "", 500);
  const advanceOrderRequested = Boolean(
    body.advance_order_requested || body.advanceOrderRequested,
  );
  const advanceOrderDetails = sanitizeText(
    body.advance_order_details || body.advanceOrderDetails || "",
    500,
  );

  if (
    !name ||
    !email ||
    !phone ||
    !reservationDate ||
    !reservationTime ||
    !Number.isInteger(partySize) ||
    partySize < 1
  ) {
    return jsonResponse(
      {
        error:
          "Please fill in your name, email, phone, date, time, and party size to book a reservation.",
      },
      400,
    );
  }

  const slotError = validateReservationSlot(reservationDate, reservationTime);
  if (slotError) return jsonResponse({ error: slotError }, 400);

  let linkedCustomerId = customer?.id || null;
  let advanceOrderId = null;
  let advancePayment = null;
  if (advanceOrderRequested && !customer) {
    // Pre-ordering needs an account; the customer then checks out from the
    // menu page (their reservation details are filled in there), and that
    // order is linked to this reservation by /api/order.
    return jsonResponse(
      { error: "Sign in is required for advance food ordering." },
      401,
    );
  }
  if (!linkedCustomerId && email) {
    const existingCustomer = await runQuery(
      env,
      "SELECT id FROM customers WHERE email = $1;",
      [email],
    );
    if (existingCustomer.rows[0])
      linkedCustomerId = existingCustomer.rows[0].id;
  }

  try {
    // A pre-order booking that was never paid was abandoned - drop it so it
    // doesn't block booking again (it was never shown to the admin).
    await runQuery(
      env,
      `
      DELETE FROM customer_reservations
      WHERE LOWER(customer_email) = $1 AND status = 'AwaitingPayment'
        AND (advance_order_id IS NULL
             OR advance_order_id IN (SELECT id FROM orders WHERE payment_status <> 'paid'));
    `,
      [email],
    );

    // One live booking per email: a new one is only allowed once the
    // previous one is Completed, Cancelled, or its date has passed.
    const existing = await runQuery(
      env,
      `
      SELECT id FROM customer_reservations
      WHERE LOWER(customer_email) = $1
        AND status IN ('Pending', 'Confirmed', 'AwaitingPayment')
        AND reservation_date >= (NOW() AT TIME ZONE 'Africa/Johannesburg')::date
      LIMIT 1;
    `,
      [email],
    );
    if (existing.rows[0]) {
      return jsonResponse(
        {
          error:
            "You already have a reservation with us under this email. Please wait until it has passed, or contact us to change it.",
          existing_reservation_id: existing.rows[0].id,
        },
        409,
      );
    }

    const result = await runQuery(
      env,
      `
      INSERT INTO customer_reservations (
        customer_id, customer_name, customer_email, customer_phone,
        reservation_date, reservation_time, party_size, table_number,
        notes, advance_order_requested, advance_order_details, advance_order_id, status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING id;
    `,
      [
        linkedCustomerId,
        name,
        email,
        phone,
        reservationDate,
        reservationTime,
        partySize,
        tableNumber || null,
        notes || null,
        advanceOrderRequested,
        advanceOrderDetails || null,
        advanceOrderId,
        // With a pre-order the booking waits (hidden from the admin) until the
        // food is paid for - then it's confirmed automatically.
        advanceOrderRequested ? "AwaitingPayment" : "Pending",
      ],
    );

    await logAudit(env, {
      actor_type: linkedCustomerId ? "customer" : "guest",
      actor_id: linkedCustomerId || null,
      actor_role: linkedCustomerId ? "customer" : "guest",
      actor_ip: requestIp,
      action: "reservation_created",
      target_type: "reservation",
      target_id: result.rows[0].id,
      details: {
        reservation_date: reservationDate,
        reservation_time: reservationTime,
        party_size: partySize,
        advance_order_requested: advanceOrderRequested,
      },
    });

    if (!advanceOrderRequested) queuePush(context, { roles: ["admin"] }, {
      title: "New reservation request",
      body: `${name} · ${partySize} guest${partySize > 1 ? "s" : ""} · ${reservationDate} ${reservationTime}`,
      url: "/admin.html#reservations",
      tag: `reservation-${result.rows[0].id}`,
    });

    return jsonResponse({
      success: true,
      reservation_id: result.rows[0].id,
      advance_order_requested: advanceOrderRequested,
      message:
        "Your reservation request has been received. We should send your confirmation on WhatsApp shortly.",
    });
  } catch (err) {
    return jsonResponse(
      { error: "Failed to create reservation.", message: err.message },
      500,
    );
  }
}
