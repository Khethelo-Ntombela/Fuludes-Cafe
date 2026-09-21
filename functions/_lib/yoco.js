/**
 * functions/_lib/yoco.js
 * -----------------------------------------------------------------------
 * Helper for building a Yoco checkout redirect payload. The live Yoco
 * integration can be wired by setting YOCO_PAYMENT_URL (or YOCO_CHECKOUT_URL)
 * in your deployment environment. The checkout payload is intentionally simple
 * so it can work with a hosted page or redirect endpoint that accepts a small
 * set of order/payment fields.
 * -----------------------------------------------------------------------
 */

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
