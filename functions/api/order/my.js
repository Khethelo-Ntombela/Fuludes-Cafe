/**
 * functions/api/order/my.js
 * -----------------------------------------------------------------------
 * GET /api/order/my  (Authorization: Bearer <customer session token>)
 * The "My Orders" listing - every order ever placed by the signed-in
 * account, newest first. This replaced the old guest system entirely
 * (remembering {order id, phone} in localStorage with a 24-hour expiry) -
 * now that accounts are required to check out, order history just lives
 * on the account and is available for as long as the account exists, no
 * expiry needed.
 * -----------------------------------------------------------------------
 */
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { requireCustomer } from "../../_lib/customerAuth.js";

const MAX_ORDERS = 100;

export async function onRequestGet(context) {
  const { request, env } = context;
  const { customer, error } = await requireCustomer(request, env);
  if (error) return error;

  try {
    const ordersResult = await runQuery(env, `
      SELECT id, customer_name, customer_phone, order_type, delivery_address, table_number,
             pickup_time, special_instructions, total_amount,
             CASE WHEN status = 'Out for Delivery' THEN 'Delivery' ELSE status END AS status,
             payment_method, payment_status, kitchen_release_at, created_at
      FROM orders
      WHERE customer_id = $1
      ORDER BY created_at DESC
      LIMIT $2;
    `, [customer.id, MAX_ORDERS]);

    const orderIds = ordersResult.rows.map((o) => o.id);
    let itemsByOrder = {};
    if (orderIds.length > 0) {
      const itemsResult = await runQuery(env, `
        SELECT order_id, item_name, item_price, quantity, spice_level, extras, subtotal
        FROM order_items WHERE order_id = ANY($1::int[]) ORDER BY id ASC;
      `, [orderIds]);
      for (const row of itemsResult.rows) {
        (itemsByOrder[row.order_id] || (itemsByOrder[row.order_id] = [])).push(row);
      }
    }

    const orders = ordersResult.rows.map((order) => ({
      ...order,
      total_amount: parseFloat(order.total_amount),
      items: itemsByOrder[order.id] || []
    }));

    return jsonResponse({ orders });
  } catch (err) {
    return jsonResponse({ error: "Failed to load your orders.", message: err.message }, 500);
  }
}
