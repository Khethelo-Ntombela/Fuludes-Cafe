/**
 * functions/api/push/subscribe.js
 * -----------------------------------------------------------------------
 * GET    /api/push/subscribe  -> { publicKey }   (VAPID key for pushManager.subscribe)
 * POST   /api/push/subscribe  { role, subscription }  (Bearer token of that role)
 * DELETE /api/push/subscribe  { endpoint }
 *
 * role: "admin" (admin token) | "staff" (staff token) | "customer"
 * (customer token - pushes about their own orders/bookings only).
 * See functions/_lib/push.js for what gets sent.
 * -----------------------------------------------------------------------
 */
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { requireAdmin, requireStaff } from "../../_lib/auth.js";
import { requireCustomer } from "../../_lib/customerAuth.js";
import { ensurePushTables, getVapidKeys } from "../../_lib/push.js";

export async function onRequestGet(context) {
  try {
    const { publicKey } = await getVapidKeys(context.env);
    return jsonResponse({ publicKey });
  } catch (err) {
    return jsonResponse({ error: "Notifications aren't available right now.", message: err.message }, 500);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body." }, 400);
  }
  const role = body.role;
  const sub = body.subscription || {};
  const endpoint = typeof sub.endpoint === "string" ? sub.endpoint : "";
  const p256dh = sub.keys?.p256dh;
  const auth = sub.keys?.auth;
  if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000 || !p256dh || !auth) {
    return jsonResponse({ error: "Invalid push subscription." }, 400);
  }

  let customerId = null;
  if (role === "admin") {
    const err = await requireAdmin(request, env);
    if (err) return err;
  } else if (role === "staff") {
    const err = await requireStaff(request, env);
    if (err) return err;
  } else if (role === "customer") {
    const { customer, error } = await requireCustomer(request, env);
    if (error) return error;
    customerId = customer.id;
  } else {
    return jsonResponse({ error: "Unknown role." }, 400);
  }

  try {
    await ensurePushTables(env);
    // Same device re-subscribing (or switching account/role) just updates its row.
    await runQuery(
      env,
      `INSERT INTO push_subscriptions (role, customer_id, endpoint, p256dh, auth)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (endpoint) DO UPDATE SET role = $1, customer_id = $2, p256dh = $4, auth = $5;`,
      [role, customerId, endpoint, String(p256dh), String(auth)],
    );
    return jsonResponse({ success: true });
  } catch (err) {
    return jsonResponse({ error: "Couldn't turn on notifications.", message: err.message }, 500);
  }
}

export async function onRequestDelete(context) {
  const { request, env } = context;
  let body = {};
  try {
    body = await request.json();
  } catch {
    /* fall through */
  }
  if (!body.endpoint) return jsonResponse({ error: "endpoint is required." }, 400);
  try {
    await ensurePushTables(env);
    await runQuery(env, "DELETE FROM push_subscriptions WHERE endpoint = $1;", [String(body.endpoint)]);
    return jsonResponse({ success: true });
  } catch (err) {
    return jsonResponse({ error: "Couldn't turn off notifications.", message: err.message }, 500);
  }
}
