import { runQuery } from "../../_lib/db.js";
import { logAudit } from "../../_lib/audit.js";
import { queuePush } from "../../_lib/push.js";

function toBase64(buffer) {
  let binary = "";
  for (const byte of new Uint8Array(buffer))
    binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Yoco signs webhooks the "Standard Webhooks" way: HMAC-SHA256 over
 * "<webhook-id>.<webhook-timestamp>.<body>" keyed with the base64 part of
 * the whsec_... secret; webhook-signature holds "v1,<base64>" entries.
 */
async function verifyStandardWebhook(rawBody, request, env) {
  const id = request.headers.get("webhook-id");
  const timestamp = request.headers.get("webhook-timestamp");
  const signatures = request.headers.get("webhook-signature");
  if (!id || !timestamp || !signatures) return null; // not this scheme
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false; // replay guard: 5 minutes
  let keyBytes;
  try {
    const secret = env.YOCO_WEBHOOK_SECRET.replace(/^whsec_/, "");
    keyBytes = Uint8Array.from(atob(secret), (c) => c.charCodeAt(0));
  } catch {
    return false;
  }
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${rawBody}`));
  const expected = toBase64(signature);
  return signatures.split(" ").some((entry) => entry.split(",")[1] === expected);
}

async function verifySignature(rawBody, request, env) {
  if (!env.YOCO_WEBHOOK_SECRET) return false;
  const standard = await verifyStandardWebhook(rawBody, request, env);
  if (standard !== null) return standard;
  const supplied =
    request.headers.get("x-yoco-signature") ||
    request.headers.get("x-signature") ||
    request.headers.get("x-hook-signature");
  if (!supplied) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(env.YOCO_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(rawBody),
  );
  const base64 = toBase64(signature);
  const hex = Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return supplied === base64 || supplied === hex;
}

function extractOrderId(payload) {
  if (payload.order_id) return parseInt(payload.order_id, 10);
  if (payload.orderId) return parseInt(payload.orderId, 10);
  if (payload.reference_id) return parseInt(payload.reference_id, 10);
  if (payload.metadata?.order_id)
    return parseInt(payload.metadata.order_id, 10);
  const reference = String(payload.reference || "");
  const match = reference.match(/(\d+)$/);
  return match ? parseInt(match[1], 10) : null;
}

function extractAmount(payload) {
  if (payload.amount !== undefined) return Number(payload.amount);
  if (payload.amount_cents !== undefined)
    return Number(payload.amount_cents) / 100;
  if (payload.amount_paid !== undefined) return Number(payload.amount_paid);
  return null;
}

function isSuccessful(payload) {
  const status = String(
    payload.status ||
      payload.state ||
      payload.result ||
      payload.transaction_status ||
      "",
  ).toLowerCase();
  return (
    payload.paid === true ||
    ["success", "succeeded", "paid", "complete", "completed"].some((value) =>
      status.includes(value),
    )
  );
}

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const rawBody = await request.text();
    const contentType = (
      request.headers.get("content-type") || ""
    ).toLowerCase();
    let payload;
    if (contentType.includes("application/json")) {
      try {
        payload = JSON.parse(rawBody);
      } catch {
        payload = {};
      }
    } else {
      payload = Object.fromEntries(new URLSearchParams(rawBody));
    }

    if (!env.YOCO_WEBHOOK_SECRET)
      return new Response("webhook signing is not configured", { status: 503 });
    if (!(await verifySignature(rawBody, request, env))) {
      await logAudit(env, {
        actor_type: "payment_gateway",
        action: "payment_notify_invalid_signature",
      });
      return new Response("invalid signature", { status: 401 });
    }

    // Yoco Checkout API event: { type: "payment.succeeded", payload: { amount (cents),
    // status, metadata: { checkoutId, order_id } } } - flatten it to the shape below.
    // payment_ref becomes the checkout id (ch_...), which refunds need.
    if (typeof payload.type === "string" && payload.payload && typeof payload.payload === "object") {
      const inner = payload.payload;
      payload = {
        order_id: inner.metadata?.order_id,
        amount: Number(inner.amount) / 100,
        status: inner.status || (payload.type === "payment.succeeded" ? "succeeded" : payload.type),
        id: inner.metadata?.checkoutId || inner.id,
      };
    }

    const orderId = extractOrderId(payload);
    if (!Number.isInteger(orderId))
      return new Response("missing order id", { status: 400 });

    const orderResult = await runQuery(
      env,
      "SELECT id, total_amount, payment_status FROM orders WHERE id = $1;",
      [orderId],
    );
    const order = orderResult.rows[0];
    if (!order) return new Response("unknown order", { status: 404 });
    if (order.payment_status === "paid")
      return new Response("already processed", { status: 200 });

    const paidAmount = extractAmount(payload);
    const expectedAmount = Number(order.total_amount);
    if (
      !Number.isFinite(paidAmount) ||
      Math.abs(paidAmount - expectedAmount) > 0.01
    ) {
      await runQuery(
        env,
        "UPDATE orders SET payment_status = 'failed' WHERE id = $1 AND payment_status = 'awaiting';",
        [orderId],
      );
      await logAudit(env, {
        actor_type: "payment_gateway",
        action: "payment_notify_amount_mismatch",
        target_type: "order",
        target_id: orderId,
        details: { paidAmount, expectedAmount },
      });
      return new Response("amount mismatch", { status: 200 });
    }

    const paymentRef =
      payload.transaction_id ||
      payload.id ||
      payload.payment_id ||
      payload.reference ||
      null;
    if (isSuccessful(payload) && !paymentRef)
      return new Response("missing payment reference", { status: 400 });
    if (!isSuccessful(payload)) {
      await runQuery(
        env,
        "UPDATE orders SET payment_status = 'failed', payment_ref = $1 WHERE id = $2 AND payment_status = 'awaiting';",
        [paymentRef, orderId],
      );
      return new Response("payment failed", { status: 200 });
    }

    const items = await runQuery(
      env,
      `
      SELECT oi.menu_item_id, SUM(oi.quantity)::int AS quantity, mi.stock_quantity
      FROM order_items oi
      LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
      WHERE oi.order_id = $1
      GROUP BY oi.menu_item_id, mi.stock_quantity;
    `,
      [orderId],
    );
    for (const item of items.rows) {
      if (item.stock_quantity === null || item.stock_quantity === undefined)
        continue;
      const available = await runQuery(
        env,
        "SELECT id FROM menu_items WHERE id = $1 AND stock_quantity >= $2;",
        [item.menu_item_id, item.quantity],
      );
      if (!available.rows.length) {
        await runQuery(
          env,
          "UPDATE orders SET payment_status = 'failed' WHERE id = $1 AND payment_status = 'awaiting';",
          [orderId],
        );
        await logAudit(env, {
          actor_type: "payment_gateway",
          action: "payment_notify_stock_mismatch",
          target_type: "order",
          target_id: orderId,
        });
        return new Response("stock mismatch", { status: 409 });
      }
    }
    for (const item of items.rows) {
      if (item.stock_quantity === null || item.stock_quantity === undefined)
        continue;
      const updated = await runQuery(
        env,
        `
        UPDATE menu_items
        SET stock_quantity = stock_quantity - $1,
            is_available = (stock_quantity - $1 > 0)
        WHERE id = $2 AND stock_quantity >= $1
        RETURNING id;
      `,
        [item.quantity, item.menu_item_id],
      );
      if (!updated.rows.length) {
        await runQuery(
          env,
          "UPDATE orders SET payment_status = 'failed' WHERE id = $1 AND payment_status = 'awaiting';",
          [orderId],
        );
        return new Response("stock mismatch", { status: 409 });
      }
    }

    const paidUpdate = await runQuery(
      env,
      `
      UPDATE orders
      SET payment_status = 'paid', payment_ref = $1,
          payment_confirmed_at = NOW(),
          kitchen_release_at = NOW() + INTERVAL '2 minutes',
          stock_decremented = TRUE
      WHERE id = $2 AND payment_status = 'awaiting'
      RETURNING id, total_amount, order_type;
    `,
      [paymentRef, orderId],
    );
    const paid = paidUpdate.rows[0];
    if (paid) {
      const type = paid.order_type === "delivery" ? "Delivery" : paid.order_type === "dine_in" ? "Dine in" : "Collection";
      queuePush(context, { roles: ["admin", "staff"] }, {
        title: `New paid order #${paid.id}`,
        body: `${type} · R${Number(paid.total_amount).toFixed(2)}`,
        url: { admin: "/admin.html#orders", staff: "/staff.html" },
        tag: `order-${paid.id}`,
      });
    }
    await logAudit(env, {
      actor_type: "payment_gateway",
      actor_role: "payment",
      action: "payment_notify_processed",
      target_type: "order",
      target_id: orderId,
      details: { paymentStatus: "paid", paymentRef },
    });
    return new Response("ok", { status: 200 });
  } catch (error) {
    await logAudit(env, {
      actor_type: "payment_gateway",
      action: "payment_notify_error",
      details: { message: error.message },
    });
    return new Response("webhook processing error", { status: 500 });
  }
}
