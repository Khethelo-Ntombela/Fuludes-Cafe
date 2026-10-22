// GET /api/order/my
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { requireCustomer } from "../../_lib/customerAuth.js";
import { ensureCancelledByColumn } from "../../_lib/orderCancel.js";
import { queueDueNewOrderPushes } from "../../_lib/push.js";
import { ensureScheduleColumns } from "../../_lib/scheduledOrders.js";
import { deleteExpiredUnpaidOrders } from "../../_lib/repriceOrder.js";
import { getBusinessHours, pickupTimeNeedsChange } from "../../_lib/hours.js";

const MAX_ORDERS = 100;
const HISTORY_ORDERS = 5; // "History" always shows the 5 most recent completed orders

export async function onRequestGet(context) {
  const { request, env } = context;
  const { customer, error } = await requireCustomer(request, env);
  if (error) return error;
  const history = new URL(request.url).searchParams.get("history") === "1";

  // Sends the "new paid order" notification for orders whose 2-minute window just ended.
  queueDueNewOrderPushes(context);
  try {
    await ensureCancelledByColumn(env);
    await ensureScheduleColumns(env);
    await deleteExpiredUnpaidOrders(env);
    const ordersResult = await runQuery(env, `
      SELECT id, customer_name, customer_phone, order_type, delivery_address, table_number,
             pickup_time, special_instructions, total_amount, delivery_fee, delivery_distance_km,
             CASE WHEN status = 'Out for Delivery' THEN 'Delivery' ELSE status END AS status,
             payment_method, payment_status, refund_needed, refund_processed_at,
             payment_confirmed_at, kitchen_release_at, created_at, cancelled_by, cancel_reason, out_for_delivery_at, delivered_at, preparing_at,
             EXISTS (SELECT 1 FROM reviews rv WHERE rv.order_id = orders.id) AS reviewed,
             (SELECT json_build_object('id', r.id, 'date', to_char(r.reservation_date, 'YYYY-MM-DD'),
                                       'time', to_char(r.reservation_time, 'HH24:MI'), 'party', r.party_size)
                FROM customer_reservations r WHERE r.advance_order_id = orders.id LIMIT 1) AS reservation
      FROM orders
      WHERE customer_id = $1
        AND ${history
          ? "status = 'Completed'"
          : `created_at > NOW() - INTERVAL '24 hours'
        AND (payment_status NOT IN ('awaiting', 'failed')
             OR COALESCE((SELECT ((r.reservation_date + r.reservation_time) AT TIME ZONE 'Africa/Johannesburg')
                            FROM customer_reservations r WHERE r.advance_order_id = orders.id LIMIT 1), 'infinity'::timestamptz) > NOW())`}
      ORDER BY created_at DESC
      LIMIT $2;
    `, [customer.id, history ? HISTORY_ORDERS : MAX_ORDERS]);

    const orderIds = ordersResult.rows.map((o) => o.id);
    let itemsByOrder = {};
    if (orderIds.length > 0) {
      const itemsResult = await runQuery(env, `
        SELECT order_id, menu_item_id, item_name, item_price, quantity, spice_level, extras, subtotal
        FROM order_items WHERE order_id = ANY($1::int[]) ORDER BY id ASC;
      `, [orderIds]);
      for (const row of itemsResult.rows) {
        (itemsByOrder[row.order_id] || (itemsByOrder[row.order_id] = [])).push(row);
      }
    }

    const hours = await getBusinessHours(env);
    const orders = ordersResult.rows.map((order) => ({
      ...order,
      time_stale:
        ["awaiting", "failed"].includes(order.payment_status) &&
        order.order_type !== "dine_in" &&
        !order.reservation &&
        pickupTimeNeedsChange(order.pickup_time, order.created_at, hours),
      total_amount: parseFloat(order.total_amount),
      delivery_fee: order.delivery_fee != null ? parseFloat(order.delivery_fee) : 0,
      items: itemsByOrder[order.id] || []
    }));

    return jsonResponse({ orders });
  } catch (err) {
    return jsonResponse({ error: "Failed to load your orders.", message: err.message }, 500);
  }
}
