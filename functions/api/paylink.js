/**
 * functions/api/paylink.js
 * -----------------------------------------------------------------------
 * GET /api/paylink?token=...
 * The link the admin sends a customer (see admin/build-cart.js). Opening
 * it goes straight to the Yoco payment page for the linked order - no
 * sign-in, no intermediate page. The link is time-limited and only works
 * while the order's `payment_status` is `awaiting`; otherwise the
 * customer sees a short explanation instead.
 * -----------------------------------------------------------------------
 */
import { runQuery } from "../_lib/db.js";
import { createYocoCheckout } from "../_lib/yoco.js";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Small branded page for "this link can't be paid" cases. */
function messagePage(title, message, status = 400) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} - Fulude's Cafe</title>
<style>body{font-family:system-ui,sans-serif;background:#0a0a0a;color:#fff;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:16px}
.card{max-width:420px;text-align:center}h1{color:#c9a96e;font-size:1.4rem}a{color:#c9a96e}</style></head>
<body><div class="card"><h1>${esc(title)}</h1><p>${esc(message)}</p><p><a href="/home.html">Go to Fulude's Cafe</a></p></div></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );
}

/** Legacy (no YOCO_SECRET_KEY) checkout: a form that submits itself to the hosted page. */
function autoPostPage(payment) {
  const inputs = Object.entries(payment.fields || {})
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("");
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>Redirecting to payment…</title></head>
<body onload="document.forms[0].submit()"><form method="POST" action="${esc(payment.action_url)}">${inputs}
<noscript><button type="submit">Continue to payment</button></noscript></form></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token) return messagePage("Payment link missing", "This payment link is incomplete. Please ask the cafe to send it again.");

  try {
    // checkout_url (added by admin/build-cart.js) is this order's own Yoco checkout.
    const linkRes = await runQuery(env, "SELECT token, order_id, expires_at, used, checkout_url FROM payment_links WHERE token = $1;", [token])
      .catch(() => runQuery(env, "SELECT token, order_id, expires_at, used FROM payment_links WHERE token = $1;", [token]));
    const link = linkRes.rows[0];
    if (!link) return messagePage("Link not found", "This payment link is invalid. Please ask the cafe for a new one.", 404);
    if (link.used) return messagePage("Already used", "This payment link has already been used.");
    if (new Date(link.expires_at).getTime() < Date.now())
      return messagePage("Link expired", "This payment link has expired. Please ask the cafe for a new one.");

    const orderRes = await runQuery(env, "SELECT id, total_amount, customer_name, customer_phone, payment_status FROM orders WHERE id = $1;", [link.order_id]);
    const order = orderRes.rows[0];
    if (!order) return messagePage("Order not found", "We couldn't find the order for this link. Please contact the cafe.", 404);
    if (order.payment_status === "paid") return messagePage("Already paid", `Order #${order.id} has already been paid - thank you!`, 200);
    if (order.payment_status !== "awaiting")
      return messagePage("Not awaiting payment", `Order #${order.id} is no longer awaiting payment. Please contact the cafe.`);

    if (link.checkout_url) return Response.redirect(link.checkout_url, 302);

    const payment = await createYocoCheckout(env, {
      orderId: order.id,
      amount: parseFloat(order.total_amount),
      itemName: `Fulude's Cafe Order #${order.id}`,
      customerName: order.customer_name || "",
      customerEmail: "",
      customerPhone: order.customer_phone || "",
      returnUrl: `${url.origin}/home.html?payment=success&order_id=${order.id}`,
      cancelUrl: `${url.origin}/home.html?payment=cancelled&order_id=${order.id}`,
      notifyUrl: `${url.origin}/api/payment/notify`,
    });

    if (payment.redirect_url) return Response.redirect(payment.redirect_url, 302);
    if (payment.action_url) return autoPostPage(payment);
    return messagePage("Payments unavailable", "Online payment isn't set up yet. Please contact the cafe to pay.", 503);
  } catch (err) {
    return messagePage("Payment unavailable", `We couldn't start the payment right now (${err.message}). Please try again in a moment or contact the cafe.`, 500);
  }
}
