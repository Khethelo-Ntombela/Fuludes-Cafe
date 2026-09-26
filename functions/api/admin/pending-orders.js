/**
 * functions/api/admin/pending-orders.js
 * -----------------------------------------------------------------------
 * GET /api/admin/pending-orders
 * Polled every 30s by the admin dashboard's order monitor. Returns every
 * order still active in the kitchen lifecycle (New, Preparing, Ready, Collection, Delivery -
 * i.e. not yet Completed or Cancelled) with their line items, so admin.js
 * can detect brand-new tickets and ring an alert. The Staff Portal
 * (functions/api/staff/orders.js) is the same live board, kitchen-facing.
 * -----------------------------------------------------------------------
 */
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { requireAdmin } from "../../_lib/auth.js";
import { queueDueNewOrderPushes } from "../../_lib/push.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const authError = await requireAdmin(request, env);
  if (authError) return authError;

  // Sends the "new paid order" notification for orders whose 2-minute window just ended.
  queueDueNewOrderPushes(context);
  try {
    const ordersResult = await runQuery(
      env,
      `
      SELECT id, customer_name, customer_phone, order_type, delivery_address, table_number,
             pickup_time, special_instructions, total_amount,
             CASE WHEN status = 'Out for Delivery' THEN 'Delivery' ELSE status END AS status,
             payment_method, payment_status, payment_ref, created_at
      FROM orders
      WHERE status IN ('New', 'Preparing', 'Ready', 'Collection', 'Delivery', 'Out for Delivery')
        AND payment_status = 'paid'
        AND (kitchen_release_at IS NULL OR kitchen_release_at <= NOW())
      ORDER BY created_at ASC;
    `,
    );

    const orderIds = ordersResult.rows.map((o) => o.id);
    let itemsByOrder = {};
    if (orderIds.length > 0) {
      const itemsResult = await runQuery(
        env,
        `
        SELECT order_id, item_name, item_price, quantity, spice_level, extras, subtotal
        FROM order_items WHERE order_id = ANY($1::int[]) ORDER BY id ASC;
      `,
        [orderIds],
      );
      for (const row of itemsResult.rows) {
        (itemsByOrder[row.order_id] || (itemsByOrder[row.order_id] = [])).push(
          row,
        );
      }
    }

    const orders = ordersResult.rows.map((order) => ({
      ...order,
      total_amount: parseFloat(order.total_amount),
      items: itemsByOrder[order.id] || [],
    }));

    return jsonResponse({ orders });
  } catch (err) {
    return jsonResponse(
      { error: "Failed to load pending orders.", message: err.message },
      500,
    );
  }
}
