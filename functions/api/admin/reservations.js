/**
 * functions/api/admin/reservations.js
 * -----------------------------------------------------------------------
 * Admin/staff-facing reservation endpoints.
 *
 * GET /api/admin/reservations
 * Lists all reservations.
 *
 * POST /api/admin/reservations
 * Updates a reservation status.
 * -----------------------------------------------------------------------
 */
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { requireAdmin } from "../../_lib/auth.js";
import { sanitizeText } from "../../_lib/security.js";

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
