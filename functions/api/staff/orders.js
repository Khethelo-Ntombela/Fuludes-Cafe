/**
 * functions/api/staff/orders.js
 * -----------------------------------------------------------------------
 * GET /api/staff/orders
 * The kitchen board: every order in the active lifecycle (New,
 * Preparing, Ready, Collection, Delivery - not yet Completed/Cancelled), polled every 15s by
 * the Staff Portal so new tickets appear automatically with no refresh.
 *
 * Payment is mandatory (there's no pay-at-pickup/delivery path), so an
 * order only ever appears here once payment_status = 'paid'. Orders still
 * "awaiting" confirmation or that came back "failed" are left off the
 * board entirely - the kitchen should never start cooking something that
 * hasn't actually been paid for. functions/api/payment/notify.js flips
 * payment_status to 'paid' once the gateway confirms it, and the order
 * appears here on the next poll.
 *
 * Kept deliberately kitchen-focused: prices/totals are stripped out since
 * staff don't need them to cook, matching the "staff only sees the order
 * board, nothing else" boundary from the admin dashboard.
 * -----------------------------------------------------------------------
 */
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { requireStaff } from "../../_lib/auth.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const authError = await requireStaff(request, env);
  if (authError) return authError;

  try {
    const ordersResult = await runQuery(
      env,
      `
            SELECT id, customer_name, customer_phone, order_type, delivery_address, table_number,
               pickup_time, special_instructions, total_amount, payment_status,
               CASE WHEN status = 'Out for Delivery' THEN 'Delivery' ELSE status END AS status,
               created_at
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
        SELECT order_id, item_name, quantity, spice_level, extras
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
      items: itemsByOrder[order.id] || [],
    }));

    return jsonResponse({ orders });
  } catch (err) {
    return jsonResponse(
      { error: "Failed to load kitchen board.", message: err.message },
      500,
    );
  }
}
