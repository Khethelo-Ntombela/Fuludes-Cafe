/**
 * functions/_lib/push.js
 * -----------------------------------------------------------------------
 * Web Push (phone/desktop notifications that arrive even when the app is
 * closed), implemented with WebCrypto so it runs on Cloudflare:
 *   - VAPID auth (RFC 8292): an ES256-signed JWT per push service
 *   - payload encryption "aes128gcm" (RFC 8291 / RFC 8188)
 *
 * VAPID keys: set VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY (base64url, raw
 * P-256) in the environment, or leave them out and a key pair is created
 * once and kept in the push_config table. VAPID_SUBJECT (e.g.
 * "mailto:owner@example.com") is optional - the site URL is used otherwise.
 *
 * Subscriptions live in push_subscriptions, tagged with who they belong to:
 * role 'admin' | 'staff' | 'customer' (+ customer_id for customers).
 * Dead subscriptions (404/410 from the push service) are deleted.
 * -----------------------------------------------------------------------
 */
import { runQuery } from "./db.js";

const enc = new TextEncoder();

export function b64urlEncode(bytes) {
  let bin = "";
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(str) {
  const b64 = String(str).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

let tablesReady = false;
export async function ensurePushTables(env) {
  if (tablesReady) return;
  await runQuery(env, `
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id          SERIAL PRIMARY KEY,
      role        TEXT NOT NULL,
      customer_id INTEGER,
      endpoint    TEXT NOT NULL UNIQUE,
      p256dh      TEXT NOT NULL,
      auth        TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`);
  await runQuery(env, `
    CREATE TABLE IF NOT EXISTS push_config (
      id          INTEGER PRIMARY KEY DEFAULT 1,
      public_key  TEXT NOT NULL,
      private_key TEXT NOT NULL
    );`);
  tablesReady = true;
}

/** { publicKey, privateKey } as base64url raw P-256 keys (65-byte public, 32-byte private). */
export async function getVapidKeys(env) {
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
    return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
  }
  await ensurePushTables(env);
  const existing = (await runQuery(env, "SELECT public_key, private_key FROM push_config WHERE id = 1;")).rows[0];
  if (existing) return { publicKey: existing.public_key, privateKey: existing.private_key };

  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const rawPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const keys = { publicKey: b64urlEncode(rawPublic), privateKey: jwk.d };
  // ON CONFLICT: two first requests at once must end up with the same key.
  await runQuery(
    env,
    "INSERT INTO push_config (id, public_key, private_key) VALUES (1, $1, $2) ON CONFLICT (id) DO NOTHING;",
    [keys.publicKey, keys.privateKey],
  );
  const saved = (await runQuery(env, "SELECT public_key, private_key FROM push_config WHERE id = 1;")).rows[0];
  return { publicKey: saved.public_key, privateKey: saved.private_key };
}

async function vapidAuthHeader(endpoint, keys, subject) {
  const pub = b64urlDecode(keys.publicKey);
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", d: keys.privateKey, x: b64urlEncode(pub.slice(1, 33)), y: b64urlEncode(pub.slice(33, 65)), ext: true },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const header = b64urlEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64urlEncode(
    enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })),
  );
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64urlEncode(signature)}, k=${keys.publicKey}`;
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

/** RFC 8291 aes128gcm body for one subscription. */
async function encryptPayload(subscription, payloadText) {
  const uaPublic = b64urlDecode(subscription.p256dh);
  const authSecret = b64urlDecode(subscription.auth);

  const local = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, local.privateKey, 256));

  const ikm = await hkdf(authSecret, ecdhSecret, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const plaintext = concat(enc.encode(payloadText), new Uint8Array([2])); // 0x02 = last (only) record
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, plaintext));

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ciphertext);
}

async function sendOne(env, keys, subject, sub, payloadText) {
  try {
    const body = await encryptPayload(sub, payloadText);
    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        Authorization: await vapidAuthHeader(sub.endpoint, keys, subject),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: "86400",
        Urgency: "high",
      },
      body,
    });
    if (res.status === 404 || res.status === 410) {
      await runQuery(env, "DELETE FROM push_subscriptions WHERE endpoint = $1;", [sub.endpoint]);
    }
  } catch {
    // One bad subscription must never stop the rest (or the request that triggered it).
  }
}

/**
 * Sends a notification to everyone matching `target`:
 *   { roles: ["admin", "staff"] }  or  { customerId: 12 }
 * message: { title, body, url, tag }. `url` may be an object keyed by role
 * ({ admin: "/admin.html#orders", staff: "/staff.html" }) for per-app links.
 * Never throws.
 */
export async function sendPush(env, target, message, { origin } = {}) {
  try {
    await ensurePushTables(env);
    const subs = target.customerId
      ? (await runQuery(env, "SELECT role, endpoint, p256dh, auth FROM push_subscriptions WHERE role = 'customer' AND customer_id = $1;", [target.customerId])).rows
      : (await runQuery(env, "SELECT role, endpoint, p256dh, auth FROM push_subscriptions WHERE role = ANY($1::text[]);", [target.roles || []])).rows;
    if (!subs.length) return;
    const keys = await getVapidKeys(env);
    const subject = env.VAPID_SUBJECT || origin || "mailto:admin@localhost";
    await Promise.all(
      subs.map((sub) => {
        const url = typeof message.url === "object" ? message.url[sub.role] || "/" : message.url || "/";
        const payload = JSON.stringify({ title: message.title, body: message.body || "", url, tag: message.tag || undefined });
        return sendOne(env, keys, subject, sub, payload);
      }),
    );
  } catch {
    /* notifications are best-effort */
  }
}

/** Fire-and-forget from a Pages Function: keeps the Worker alive until sent without delaying the response. */
export function queuePush(context, target, message) {
  const origin = new URL(context.request.url).origin;
  const job = sendPush(context.env, target, message, { origin });
  if (typeof context.waitUntil === "function") context.waitUntil(job);
  return job;
}

const ORDER_STATUS_TEXT = {
  Preparing: "is being prepared in the kitchen.",
  Ready: "is ready!",
  Collection: "is ready for collection.",
  Delivery: "is on its way to you.",
  Completed: "is complete - enjoy your meal!",
  Cancelled: "was cancelled. Contact us if you have any questions.",
};

/** Tells the customer who placed an order that its status changed (no-op for guest/admin-built orders). */
export function queueOrderStatusPush(context, customerId, orderId, status) {
  if (!customerId || !ORDER_STATUS_TEXT[status]) return;
  return queuePush(context, { customerId }, {
    title: `Order #${orderId} update`,
    body: `Your order #${orderId} ${ORDER_STATUS_TEXT[status]}`,
    url: "/home.html?my_orders=1",
    tag: `order-${orderId}`,
  });
}
