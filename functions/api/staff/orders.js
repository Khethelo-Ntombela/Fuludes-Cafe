// GET /api/staff/orders
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { requireStaff } from "../../_lib/auth.js";
import { queueDueNewOrderPushes } from "../../_lib/push.js";
import { ensureScheduleColumns } from "../../_lib/scheduledOrders.js";
import { ORDER_SHOW_AT, ORDER_VISIBLE_NOW } from "../../_lib/preorderVisibility.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const authError = await requireStaff(request, env);
  if (authError) return authError;

  // Sends the "new paid order" notification for orders whose 2-minute window just ended.
  queueDueNewOrderPushes(context);
  try {
    await ensureScheduleColumns(env);
    const ordersResult = await runQuery(
      env,
      `
            SELECT id, customer_name, customer_phone, order_type, delivery_address, table_number,
               pickup_time, special_instructions, total_amount, payment_status,
               delivery_fee, delivery_distance_km, delivery_lat, delivery_lng, payment_confirmed_at, kitchen_release_at, scheduled_for, preparing_at,
               CASE WHEN status = 'Out for Delivery' THEN 'Delivery' ELSE status END AS status,
               created_at
      FROM orders
      WHERE status IN ('New', 'Preparing', 'Ready', 'Collection', 'Delivery', 'Out for Delivery')
        AND payment_status = 'paid'
        AND ${ORDER_VISIBLE_NOW}
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

    // When the next paid order leaves its 2-minute cancel window, so the board
    // can fetch at that exact moment and ring straight away (not on the next 5s poll).
    const next = await runQuery(
      env,
      `SELECT MIN(${ORDER_SHOW_AT}) AS next_release_at, NOW() AS server_now
         FROM orders
        WHERE payment_status = 'paid' AND status = 'New' AND kitchen_release_at IS NOT NULL AND ${ORDER_SHOW_AT} > NOW();`,
    );

    return jsonResponse({
      orders,
      next_release_at: next.rows[0]?.next_release_at || null,
      server_now: next.rows[0]?.server_now || null,
    });
  } catch (err) {
    return jsonResponse(
      { error: "Failed to load kitchen board.", message: err.message },
      500,
    );
  }
}
