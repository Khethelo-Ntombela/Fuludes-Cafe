/**
 * functions/api/admin/order-delivered.js
 * -----------------------------------------------------------------------
 * POST /api/admin/order-delivered   { order_id, delivered: true | false }
 * The "Delivered" tick in admin Order History. Sets/clears orders.delivered_at,
 * which ends the delivery ETA on the customer's order tracker. Separate from
 * Completed (that only clears the live kitchen screens).
 * -----------------------------------------------------------------------
 */
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { requireAdmin } from "../../_lib/auth.js";
import { ensureScheduleColumns } from "../../_lib/scheduledOrders.js";

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
  const orderId = Number(body.order_id);
  if (!Number.isInteger(orderId)) return jsonResponse({ error: "A valid order_id is required." }, 400);
  const delivered = body.delivered !== false;

  try {
    await ensureScheduleColumns(env);
    const result = await runQuery(
      env,
      `UPDATE orders
          SET delivered_at = CASE WHEN $2 THEN COALESCE(delivered_at, NOW()) ELSE NULL END
        WHERE id = $1 AND order_type = 'delivery' AND status IN ('Delivery', 'Out for Delivery', 'Completed')
        RETURNING id, delivered_at;`,
      [orderId, delivered],
    );
    if (result.rows.length === 0) {
      return jsonResponse({ error: "Only delivery orders that are out for delivery or completed can be ticked." }, 400);
    }
    return jsonResponse({ success: true, order_id: orderId, delivered_at: result.rows[0].delivered_at });
  } catch (err) {
    return jsonResponse({ error: "Failed to update delivered state.", message: err.message }, 500);
  }
}
