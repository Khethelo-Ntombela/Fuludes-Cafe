/**
 * functions/api/admin/buffet-bookings.js
 * -----------------------------------------------------------------------
 * Admin endpoints to list and update buffet bookings.
 * GET  /api/admin/buffet-bookings?event_id=1  -> { bookings: [...] }
 * POST /api/admin/buffet-bookings            -> { action: 'confirm'|'cancel', booking_id }
 * -----------------------------------------------------------------------
 */
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { requireAdmin } from "../../_lib/auth.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const authErr = await requireAdmin(request, env);
  if (authErr) return authErr;
  try {
    const params = new URL(request.url).searchParams;
    const event_id = params.get("event_id");
    let res;
    if (event_id) {
      res = await runQuery(
        env,
        "SELECT id, event_id, customer_id, name, email, phone, seats, status, created_at FROM buffet_bookings WHERE event_id = $1 ORDER BY created_at DESC;",
        [Number(event_id)],
      );
    } else {
      res = await runQuery(
        env,
        "SELECT id, event_id, customer_id, name, email, phone, seats, status, created_at FROM buffet_bookings ORDER BY created_at DESC LIMIT 200;",
        [],
      );
    }
    return jsonResponse({ bookings: res.rows });
  } catch (err) {
    return jsonResponse(
      { error: "Failed to list bookings.", message: err.message },
      500,
    );
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const authErr = await requireAdmin(request, env);
  if (authErr) return authErr;
  try {
    const body = await request.json();
    const booking_id = Number(body.booking_id);
    const action = body.action;
    if (!booking_id || !action)
      return jsonResponse({ error: "Missing booking_id or action" }, 400);
    if (action === "cancel") {
      await runQuery(
        env,
        "UPDATE buffet_bookings SET status='cancelled' WHERE id=$1;",
        [booking_id],
      );
      return jsonResponse({ success: true });
    }
    if (action === "confirm") {
      await runQuery(
        env,
        "UPDATE buffet_bookings SET status='confirmed' WHERE id=$1;",
        [booking_id],
      );
      return jsonResponse({ success: true });
    }
    return jsonResponse({ error: "Unknown action" }, 400);
  } catch (err) {
    return jsonResponse(
      { error: "Failed to update booking.", message: err.message },
      500,
    );
  }
}
