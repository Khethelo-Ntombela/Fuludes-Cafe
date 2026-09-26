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
import { queuePush } from "../../_lib/push.js";
import { cancelAndRefundOrder } from "../../_lib/reservations.js";

let _colReady = false;
async function ensureClearedColumn(env) {
  if (_colReady) return;
  try {
    await runQuery(env, "ALTER TABLE customer_reservations ADD COLUMN IF NOT EXISTS admin_cleared BOOLEAN NOT NULL DEFAULT FALSE;");
    _colReady = true;
  } catch { /* table may be managed elsewhere */ }
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const authError = await requireAdmin(request, env);
  if (authError) return authError;

  try {
    await ensureClearedColumn(env);
    const result = await runQuery(
      env,
      `
      SELECT r.id, r.customer_name, r.customer_email, r.customer_phone,
             to_char(r.reservation_date, 'YYYY-MM-DD') AS reservation_date,
             to_char(r.reservation_time, 'HH24:MI') AS reservation_time,
             r.party_size, r.table_number, r.notes,
             r.advance_order_requested, r.advance_order_details, r.advance_order_id,
             r.status, r.admin_cleared, r.created_at,
             o.payment_status AS preorder_payment_status, o.total_amount AS preorder_total
      FROM customer_reservations r
      LEFT JOIN orders o ON o.id = r.advance_order_id
      -- Pre-order bookings only appear once the food has been paid for.
      WHERE r.status <> 'AwaitingPayment'
      ORDER BY r.reservation_date ASC, r.reservation_time ASC, r.created_at DESC;
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

  // "Clear": take a fulfilled (Completed) or Cancelled booking off the admin
  // list. The row is kept, so Completed ones still count in today's stats.
  if (body.action === "clear" || body.action === "clear_finished") {
    try {
      await ensureClearedColumn(env);
      const id = parseInt(body.reservation_id || body.id, 10);
      const result =
        body.action === "clear" && Number.isInteger(id)
          ? await runQuery(env, `UPDATE customer_reservations SET admin_cleared = TRUE WHERE id = $1 AND status IN ('Completed','Cancelled') RETURNING id;`, [id])
          : await runQuery(env, `UPDATE customer_reservations SET admin_cleared = TRUE WHERE status IN ('Completed','Cancelled') AND admin_cleared = FALSE RETURNING id;`);
      return jsonResponse({ success: true, cleared: result.rows.length });
    } catch (err) {
      return jsonResponse({ error: "Failed to clear.", message: err.message }, 500);
    }
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
    const current = (
      await runQuery(
        env,
        `SELECT r.status, r.advance_order_id, o.payment_status AS preorder_payment_status
           FROM customer_reservations r LEFT JOIN orders o ON o.id = r.advance_order_id
          WHERE r.id = $1;`,
        [reservationId],
      )
    ).rows[0];
    if (!current) return jsonResponse({ error: "Reservation not found." }, 404);
    const prepaid = ["paid", "refunded"].includes(current.preorder_payment_status);
    // A paid pre-order booking is confirmed by the payment - it can only
    // move on to Cancelled or Completed, never back to Pending.
    if (prepaid && status === "Pending") {
      return jsonResponse({ error: "This booking's pre-order is paid, so it stays Confirmed (or choose Cancelled / Completed)." }, 400);
    }

    const updated = await runQuery(
      env,
      `
      UPDATE customer_reservations
      SET status = $1
      WHERE id = $2
      RETURNING customer_id, to_char(reservation_date, 'DD Mon') AS day, to_char(reservation_time, 'HH24:MI') AS time;
    `,
      [status, reservationId],
    );
    const r = updated.rows[0];

    // Cancelling a prepaid booking cancels its pre-order and refunds it through Yoco.
    let refund = null;
    if (status === "Cancelled" && current.status !== "Cancelled" && current.advance_order_id && prepaid) {
      refund = await cancelAndRefundOrder(env, current.advance_order_id, "admin");
    }

    if (r?.customer_id && (status === "Confirmed" || status === "Cancelled")) {
      queuePush(context, { customerId: r.customer_id }, {
        title: `Reservation ${status.toLowerCase()}`,
        body:
          status === "Cancelled" && prepaid
            ? `Your table for ${r.day} at ${r.time} has been cancelled and your pre-order will be refunded.`
            : `Your table for ${r.day} at ${r.time} is ${status.toLowerCase()}.`,
        url: "/home.html",
        tag: `reservation-${reservationId}`,
      });
    }

    return jsonResponse({ success: true, refund });
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
