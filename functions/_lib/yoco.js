// Starts a Yoco payment for an order

import { runQuery } from "./db.js";

export const YOCO_API_BASE = "https://payments.yoco.com/api";

/** "test" / "live" from the secret key prefix (sk_test_ / sk_live_). */
export function yocoKeyMode(env) {
  const key = env.YOCO_SECRET_KEY || "";
  return key.startsWith("sk_test") ? "test" : key.startsWith("sk_live") ? "live" : key ? "unknown" : "missing";
}

let yocoTablesReady = false;
/** orders.yoco_checkout_id + the yoco_webhooks table (webhook secrets saved by Settings > Payments). */
export async function ensureYocoTables(env) {
  if (yocoTablesReady) return;
  await runQuery(env, "ALTER TABLE orders ADD COLUMN IF NOT EXISTS yoco_checkout_id TEXT;");
  await runQuery(env, `
    CREATE TABLE IF NOT EXISTS yoco_webhooks (
      id         TEXT PRIMARY KEY,
      mode       TEXT,
      url        TEXT NOT NULL,
      secret     TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`);
  // Every checkout we open, with the amount and the order lines as they were priced at that moment.
  // If the customer pays on an earlier checkout (for example a tab they left open), the payment webhook
  // uses this to charge - and record - exactly the price that checkout showed.
  await runQuery(env, `
    CREATE TABLE IF NOT EXISTS order_checkouts (
      checkout_id TEXT PRIMARY KEY,
      order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      amount      NUMERIC(10,2) NOT NULL,
      lines       JSONB NOT NULL DEFAULT '[]',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`);
  await runQuery(env, "CREATE INDEX IF NOT EXISTS idx_order_checkouts_order ON order_checkouts(order_id);");
  yocoTablesReady = true;
}

/** Every webhook signing secret we know: the env var plus any saved by Settings > Payments. */
export async function yocoWebhookSecrets(env) {
  const secrets = env.YOCO_WEBHOOK_SECRET ? [env.YOCO_WEBHOOK_SECRET] : [];
  try {
    await ensureYocoTables(env);
    const rows = (await runQuery(env, "SELECT secret FROM yoco_webhooks ORDER BY created_at DESC;")).rows;
    for (const r of rows) if (r.secret && !secrets.includes(r.secret)) secrets.push(r.secret);
  } catch {
    /* database unavailable - fall back to the env secret */
  }
  return secrets;
}

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

// Returns { redirect_url, checkout_id } when Yoco's Checkout API is available
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
  // Remember which checkout belongs to the order, so the payment webhook
  // can always find it (even if Yoco doesn't echo our metadata back).
  try {
    await ensureYocoTables(env);
    await runQuery(env, "UPDATE orders SET yoco_checkout_id = $1 WHERE id = $2;", [data.id, orderId]);
    const lines = await runQuery(env, "SELECT id, item_price, extras, subtotal FROM order_items WHERE order_id = $1 ORDER BY id;", [orderId]);
    await runQuery(
      env,
      `INSERT INTO order_checkouts (checkout_id, order_id, amount, lines) VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (checkout_id) DO NOTHING;`,
      [data.id, orderId, Math.round(amount * 100) / 100, JSON.stringify(lines.rows)],
    );
  } catch {
    /* non-fatal: the webhook also carries metadata.order_id */
  }
  return { redirect_url: data.redirectUrl, checkout_id: data.id };
}
