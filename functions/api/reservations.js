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

export async function onRequestGet(context) {
  const { request, env } = context;
  const { customer, error } = await requireCustomer(request, env);
  if (error) return error;

  try {
    const result = await runQuery(
      env,
      `
      SELECT id, reservation_date, reservation_time, party_size, table_number, notes,
             advance_order_requested, advance_order_details, status, created_at
      FROM customer_reservations
      WHERE customer_id = $1
      ORDER BY reservation_date DESC, reservation_time DESC;
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

  let linkedCustomerId = customer?.id || null;
  let advanceOrderId = null;
  let advancePayment = null;
  if (advanceOrderRequested) {
    const authorization = request.headers.get("Authorization") || "";
    if (!customer || !authorization.startsWith("Bearer "))
      return jsonResponse(
        { error: "Sign in is required for advance food ordering." },
        401,
      );
    const cartItems = Array.isArray(body.cart_items) ? body.cart_items : [];
    if (cartItems.length === 0)
      return jsonResponse(
        { error: "Add your advance food order to the cart before booking." },
        400,
      );
    const orderRequest = new Request(new URL("/api/order", request.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: authorization,
      },
      body: JSON.stringify({
        customer_name: name,
        phone_number: phone,
        order_type: "dine_in",
        pickup_time: reservationTime,
        special_instructions: notes,
        cart_items: cartItems,
      }),
    });
    const { onRequestPost } = await import("./order.js");
    const orderResponse = await onRequestPost({ request: orderRequest, env });
    const orderBody = await orderResponse
      .clone()
      .json()
      .catch(() => ({}));
    if (!orderResponse.ok || !orderBody.success) return orderResponse;
    advanceOrderId = orderBody.order_id;
    advancePayment = orderBody.payment;
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
    const result = await runQuery(
      env,
      `
      INSERT INTO customer_reservations (
        customer_id, customer_name, customer_email, customer_phone,
        reservation_date, reservation_time, party_size, table_number,
        notes, advance_order_requested, advance_order_details, advance_order_id, status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'Pending')
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

    return jsonResponse({
      success: true,
      reservation_id: result.rows[0].id,
      payment: advancePayment,
      message: advancePayment
        ? "Reservation received. Complete payment to confirm your advance food order."
        : "Your reservation request has been received. The cafe will confirm it shortly.",
    });
  } catch (err) {
    return jsonResponse(
      { error: "Failed to create reservation.", message: err.message },
      500,
    );
  }
}
