/**
 * functions/api/admin/reservations.js
 * -----------------------------------------------------------------------
 * Admin/staff-facing reservation endpoints.
 *
 * GET /api/admin/reservations
 * Lists all reservations.
 *
 * POST /api/admin/reservations
 *   { action: "create", name, phone, email?, reservation_date, reservation_time,
 *     party_size, table_number?, notes?, status? }
 *     -> books a table on behalf of a customer who phoned in (same fields and
 *        checks as the customer-facing form; email is optional here; the
 *        booking starts as "Confirmed" unless another status is sent).
 *   { reservation_id, status } -> updates a reservation status.
 * -----------------------------------------------------------------------
 */
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { requireAdmin } from "../../_lib/auth.js";
import { sanitizeText } from "../../_lib/security.js";
import { logAudit } from "../../_lib/audit.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const authError = await requireAdmin(request, env);
  if (authError) return authError;

  try {
    const result = await runQuery(
      env,
      `
      SELECT id, customer_name, customer_email, customer_phone, reservation_date,
             reservation_time, party_size, table_number, notes,
             advance_order_requested, advance_order_details, status, created_at
      FROM customer_reservations
      ORDER BY reservation_date ASC, reservation_time ASC, created_at DESC;
    `,
    );

    return jsonResponse({ reservations: result.rows });
  } catch (err) {
    return jsonResponse(
      { error: "Failed to load reservations.", message: err.message },
      500,
    );
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const authError = await requireAdmin(request, env);
  if (authError) return authError;

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body." }, 400);
  }

  if (body.action === "create") return createReservation(env, body);

  const reservationId = parseInt(body.reservation_id || body.id, 10);
  const status = sanitizeText(body.status || "", 50);
  if (!Number.isInteger(reservationId) || !status) {
    return jsonResponse(
      { error: "A valid reservation id and status are required." },
      400,
    );
  }

  if (!["Pending", "Confirmed", "Cancelled", "Completed"].includes(status)) {
    return jsonResponse({ error: "Invalid reservation status." }, 400);
  }

  try {
    await runQuery(
      env,
      `
      UPDATE customer_reservations
      SET status = $1
      WHERE id = $2;
    `,
      [status, reservationId],
    );

    return jsonResponse({ success: true });
  } catch (err) {
    return jsonResponse(
      { error: "Failed to update reservation.", message: err.message },
      500,
    );
  }
}

async function createReservation(env, body) {
  const name = sanitizeText(body.name || "", 100);
  const email = sanitizeText(body.email || "", 100).toLowerCase();
  const phone = sanitizeText(body.phone || "", 50);
  const date = sanitizeText(body.reservation_date || "", 30);
  const time = sanitizeText(body.reservation_time || "", 30);
  const partySize = parseInt(body.party_size, 10);
  const tableNumber = sanitizeText(body.table_number || "", 30);
  const notes = sanitizeText(body.notes || "", 500);
  const status = ["Pending", "Confirmed"].includes(body.status) ? body.status : "Confirmed";

  if (!name || !phone || !date || !time || !Number.isInteger(partySize) || partySize < 1) {
    return jsonResponse(
      { error: "Please fill in the customer's name, phone, date, time and party size." },
      400,
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return jsonResponse({ error: "Enter the date as YYYY-MM-DD." }, 400);
  }

  try {
    let customerId = null;
    if (email) {
      const existing = await runQuery(env, "SELECT id FROM customers WHERE email = $1;", [email]);
      customerId = existing.rows[0]?.id || null;
    }
    // customer_email is NOT NULL in the table; phone bookings often have no email.
    const result = await runQuery(
      env,
      `INSERT INTO customer_reservations (
         customer_id, customer_name, customer_email, customer_phone,
         reservation_date, reservation_time, party_size, table_number, notes, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id;`,
      [customerId, name, email, phone, date, time, partySize, tableNumber || null, notes || null, status],
    );
    await logAudit(env, {
      actor_type: "admin",
      actor_role: "admin",
      action: "admin_reservation_created",
      target_type: "reservation",
      target_id: result.rows[0].id,
      details: { reservation_date: date, reservation_time: time, party_size: partySize },
    });
    return jsonResponse({ success: true, reservation_id: result.rows[0].id, status }, 201);
  } catch (err) {
    return jsonResponse({ error: "Failed to create the reservation.", message: err.message }, 500);
  }
}
