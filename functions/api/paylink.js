/**
 * functions/api/paylink.js
 * -----------------------------------------------------------------------
 * GET /api/paylink?token=...  -> returns a Yoco checkout payload for the
 * linked order so the recipient can complete payment without signing in.
 * The link is time-limited and will only work while the order's
 * `payment_status` is `awaiting`.
 * -----------------------------------------------------------------------
 */
import { runQuery, jsonResponse } from "../_lib/db.js";
import { buildYocoCheckout } from "../_lib/yoco.js";

export async function onRequestGet(context) {
  const { url, env } = context;
  const token = (new URL(url)).searchParams.get('token');
  if (!token) return jsonResponse({ error: 'Missing token.' }, 400);

  try {
    const linkRes = await runQuery(env, 'SELECT token, order_id, expires_at, used FROM payment_links WHERE token = $1;', [token]);
    const link = linkRes.rows[0];
    if (!link) return jsonResponse({ error: 'Invalid or expired link.' }, 404);
    if (link.used) return jsonResponse({ error: 'This payment link has already been used.' }, 400);
    if (new Date(link.expires_at).getTime() < Date.now()) return jsonResponse({ error: 'This payment link has expired.' }, 400);

    const orderRes = await runQuery(env, 'SELECT id, total_amount, customer_name, payment_status FROM orders WHERE id = $1;', [link.order_id]);
    const order = orderRes.rows[0];
    if (!order) return jsonResponse({ error: 'Linked order not found.' }, 404);
    if (order.payment_status !== 'awaiting') return jsonResponse({ error: 'This order is not awaiting payment.' }, 400);

    const origin = new URL(url).origin;
    const payment = buildYocoCheckout(env, {
      orderId: order.id,
      amount: parseFloat(order.total_amount),
      itemName: `Fulude's Cafe Order #${order.id}`,
      customerName: order.customer_name || '',
      customerEmail: '',
      customerPhone: '',
      returnUrl: `${origin}/home.html?payment=success&order_id=${order.id}`,
      cancelUrl: `${origin}/home.html?payment=cancelled&order_id=${order.id}`,
      notifyUrl: `${origin}/api/payment/notify`
    });

    return jsonResponse({ success: true, payment });
  } catch (err) {
    return jsonResponse({ error: 'Failed to resolve payment link.', message: err.message }, 500);
  }
}
