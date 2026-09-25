/**
 * functions/_lib/yoco.js
 * -----------------------------------------------------------------------
 * Starts a Yoco payment for an order.
 *
 * With YOCO_SECRET_KEY set (the normal setup) this calls Yoco's Checkout
 * API (POST https://payments.yoco.com/api/checkouts), which returns a
 * `redirectUrl` - the customer's browser goes straight there to pay.
 * https://developer.yoco.com/guides/online-payments/accepting-a-payment
 *
 * Without YOCO_SECRET_KEY it falls back to the older hosted-form payload
 * (fields POSTed to YOCO_PAYMENT_URL / YOCO_CHECKOUT_URL).
 * -----------------------------------------------------------------------
 */

const YOCO_API_BASE = "https://payments.yoco.com/api";

export function buildYocoCheckout(env, { orderId, amount, itemName, customerName, customerEmail, customerPhone, returnUrl, cancelUrl, notifyUrl }) {
  const paymentUrl = env.YOCO_PAYMENT_URL || env.YOCO_CHECKOUT_URL || "";
  const fields = {
    order_id: String(orderId),
    reference: `fulude-${orderId}`,
    amount: String(Math.round(amount * 100)),
    currency: env.YOCO_CURRENCY || "ZAR",
    item_name: itemName || `Fulude's Cafe Order #${orderId}`,
    customer_name: customerName || "",
    customer_email: customerEmail || "",
    customer_phone: customerPhone || "",
    return_url: returnUrl || "",
    cancel_url: cancelUrl || "",
    notify_url: notifyUrl || ""
  };

  return {
    action_url: paymentUrl,
    fields
  };
}

/**
 * Returns { redirect_url, checkout_id } when Yoco's Checkout API is
 * available, otherwise the legacy { action_url, fields } form payload.
 * Throws if the Yoco API call itself fails.
 */
export async function createYocoCheckout(env, params) {
  if (!env.YOCO_SECRET_KEY) return buildYocoCheckout(env, params);

  const { orderId, amount, returnUrl, cancelUrl } = params;
  const res = await fetch(`${YOCO_API_BASE}/checkouts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.YOCO_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount: Math.round(amount * 100),
      currency: env.YOCO_CURRENCY || "ZAR",
      successUrl: returnUrl,
      cancelUrl,
      failureUrl: cancelUrl,
      metadata: { order_id: String(orderId), reference: `fulude-${orderId}` },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.redirectUrl) {
    throw new Error(data.message || data.description || `Yoco checkout failed (status ${res.status}).`);
  }
  return { redirect_url: data.redirectUrl, checkout_id: data.id };
}
