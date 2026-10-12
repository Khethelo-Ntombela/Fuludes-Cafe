/** Admin payment setup and Yoco webhook management. Test and live keys use separate webhooks. */
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { requireAdmin } from "../../_lib/auth.js";
import { logAudit } from "../../_lib/audit.js";
import { YOCO_API_BASE, yocoKeyMode, ensureYocoTables } from "../../_lib/yoco.js";

function yocoFetch(env, path, init = {}) {
  return fetch(`${YOCO_API_BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${env.YOCO_SECRET_KEY}`, "Content-Type": "application/json", ...(init.headers || {}) },
    signal: AbortSignal.timeout(15000),
  });
}

async function listYocoWebhooks(env) {
  const res = await yocoFetch(env, "/webhooks");
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.description || `Yoco said ${res.status}`);
  return Array.isArray(data.subscriptions) ? data.subscriptions : Array.isArray(data) ? data : [];
}

async function status(request, env) {
  await ensureYocoTables(env);
  const notifyUrl = `${new URL(request.url).origin}/api/payment/notify`;
  const mode = yocoKeyMode(env);
  const saved = (await runQuery(env, "SELECT id, mode, url, created_at FROM yoco_webhooks ORDER BY created_at DESC;")).rows;

  let registered = [];
  let yocoError = null;
  if (env.YOCO_SECRET_KEY) {
    try {
      registered = await listYocoWebhooks(env);
    } catch (err) {
      yocoError = err.message;
    }
  }
  const forThisSite = registered.filter((w) => w.url === notifyUrl);
  const haveSecret = forThisSite.some((w) => saved.some((s) => s.id === w.id)) || (forThisSite.length > 0 && Boolean(env.YOCO_WEBHOOK_SECRET));

  const events = (
    await runQuery(
      env,
      `SELECT action, target_id, details, created_at FROM audit_logs
        WHERE (action LIKE 'payment_notify%' OR action = 'order_marked_paid')
          AND created_at >= date_trunc('month', NOW() AT TIME ZONE 'Africa/Johannesburg') AT TIME ZONE 'Africa/Johannesburg'
        ORDER BY created_at DESC LIMIT 20;`,
    ).catch(() => ({ rows: [] }))
  ).rows;

  return {
    key_mode: mode,
    notify_url: notifyUrl,
    env_webhook_secret: Boolean(env.YOCO_WEBHOOK_SECRET),
    yoco_error: yocoError,
    webhooks: registered.map((w) => ({ id: w.id, name: w.name, url: w.url, mode: w.mode })),
    connected: forThisSite.length > 0 && haveSecret,
    recent_events: events,
  };
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const authError = await requireAdmin(request, env);
  if (authError) return authError;
  try {
    return jsonResponse(await status(request, env));
  } catch (err) {
    return jsonResponse({ error: "Couldn't read the payment setup.", message: err.message }, 500);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const authError = await requireAdmin(request, env);
  if (authError) return authError;
  let body = {};
  try {
    body = await request.json();
  } catch {
    /* handled below */
  }
  if (body.action !== "connect") return jsonResponse({ error: "Unknown action." }, 400);
  if (!env.YOCO_SECRET_KEY) {
    return jsonResponse({ error: "YOCO_SECRET_KEY isn't set in Cloudflare yet - add your Yoco secret key there and redeploy first." }, 400);
  }

  try {
    await ensureYocoTables(env);
    const notifyUrl = `${new URL(request.url).origin}/api/payment/notify`;

    // Replace any earlier registration of this URL - Yoco only shows a secret once.
    for (const w of await listYocoWebhooks(env)) {
      if (w.url === notifyUrl) await yocoFetch(env, `/webhooks/${encodeURIComponent(w.id)}`, { method: "DELETE" }).catch(() => {});
    }

    const res = await yocoFetch(env, "/webhooks", {
      method: "POST",
      body: JSON.stringify({ name: "fuludes-cafe", url: notifyUrl }),
    });
    const created = await res.json().catch(() => ({}));
    if (!res.ok || !created.secret) {
      throw new Error(created.message || created.description || `Yoco said ${res.status}`);
    }

    await runQuery(env, "DELETE FROM yoco_webhooks WHERE url = $1 AND (mode = $2 OR mode IS NULL);", [notifyUrl, created.mode || null]);
    await runQuery(
      env,
      "INSERT INTO yoco_webhooks (id, mode, url, secret) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO UPDATE SET secret = $4, mode = $2, url = $3;",
      [created.id, created.mode || null, notifyUrl, created.secret],
    );
    await logAudit(env, {
      action: "yoco_webhook_connected",
      target_type: "yoco_webhook",
      details: { webhook_id: created.id, mode: created.mode, url: notifyUrl },
    });
    return jsonResponse({ success: true, ...(await status(request, env)) });
  } catch (err) {
    return jsonResponse({ error: `Couldn't connect to Yoco: ${err.message}` }, 502);
  }
}
