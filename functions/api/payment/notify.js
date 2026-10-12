import { runQuery } from "../../_lib/db.js";
import { logAudit } from "../../_lib/audit.js";
import { ensureNewOrderPushColumn } from "../../_lib/push.js";
import { yocoWebhookSecrets, ensureYocoTables } from "../../_lib/yoco.js";
import { confirmPreorderReservation, cancelAndRefundOrder } from "../../_lib/reservations.js";
import { takeOrderStock } from "../../_lib/stock.js";

function toBase64(buffer) {
  let binary = "";
  for (const byte of new Uint8Array(buffer))
    binary += String.fromCharCode(byte);
  return btoa(binary);
}

// Yoco signs webhooks the "Standard Webhooks" way
async function verifyStandardWebhook(rawBody, request, secretValue) {
  const id = request.headers.get("webhook-id");
  const timestamp = request.headers.get("webhook-timestamp");
  const signatures = request.headers.get("webhook-signature");
  if (!id || !timestamp || !signatures) return null; // not this scheme
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false; // replay guard: 5 minutes
  let keyBytes;
  try {
    const secret = secretValue.replace(/^whsec_/, "");
    keyBytes = Uint8Array.from(atob(secret), (c) => c.charCodeAt(0));
  } catch {
    return false;
  }
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${rawBody}`));
  const expected = toBase64(signature);
  return signatures.split(" ").some((entry) => entry.split(",")[1] === expected);
}

/** Accepts signatures from configured or saved webhook secrets. */
async function verifySignature(rawBody, request, secrets) {
  for (const secret of secrets) {
    if (await verifySignatureWith(rawBody, request, secret)) return true;
  }
  return false;
}

async function verifySignatureWith(rawBody, request, secretValue) {
  const standard = await verifyStandardWebhook(rawBody, request, secretValue);
  if (standard !== null) return standard;
  const supplied =
    request.headers.get("x-yoco-signature") ||
    request.headers.get("x-signature") ||
    request.headers.get("x-hook-signature");
  if (!supplied) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secretValue),
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

    // Every rejection is written to the Audit log, so "paid on Yoco but not
    // in the app" can be diagnosed from the admin (Audit tab).
    const secrets = await yocoWebhookSecrets(env);
    if (!secrets.length) {
      await logAudit(env, {
        actor_type: "payment_gateway",
        action: "payment_notify_not_configured",
        details: { hint: "Admin > Settings > Payments > Connect payment notifications" },
      });
      return new Response("webhook signing is not configured", { status: 503 });
    }
    if (!(await verifySignature(rawBody, request, secrets))) {
      await logAudit(env, {
        actor_type: "payment_gateway",
        action: "payment_notify_invalid_signature",
        details: { event_type: payload.type || null, has_standard_headers: Boolean(request.headers.get("webhook-signature")) },
      });
      return new Response("invalid signature", { status: 401 });
    }
    const eventType = payload.type || null;

    // Yoco Checkout API event: { type: "payment.succeeded", payload: { amount (cents), status, metadata
    if (typeof payload.type === "string" && payload.payload && typeof payload.payload === "object") {
      const inner = payload.payload;
      payload = {
        order_id: inner.metadata?.order_id,
        checkout_id: inner.metadata?.checkoutId || null,
        amount: Number(inner.amount) / 100,
        status: inner.status || (payload.type === "payment.succeeded" ? "succeeded" : payload.type),
        id: inner.metadata?.checkoutId || inner.id,
      };
    }

    let orderId = extractOrderId(payload);
    if (!Number.isInteger(orderId) && payload.checkout_id) {
      // No order number in the event: find the order by the Yoco checkout it was paid through.
      await ensureYocoTables(env).catch(() => {});
      const byCheckout = await runQuery(env, "SELECT id FROM orders WHERE yoco_checkout_id = $1;", [payload.checkout_id]).catch(() => ({ rows: [] }));
      if (byCheckout.rows[0]) orderId = byCheckout.rows[0].id;
    }
    if (!Number.isInteger(orderId)) {
      await logAudit(env, {
        actor_type: "payment_gateway",
        action: "payment_notify_unmatched",
        details: { event_type: eventType, checkout_id: payload.checkout_id || null },
      });
      return new Response("missing order id", { status: 400 });
    }

    const orderResult = await runQuery(
      env,
      "SELECT id, total_amount, payment_status FROM orders WHERE id = $1;",
      [orderId],
    );
    const order = orderResult.rows[0];
    if (!order) return new Response("unknown order", { status: 404 });
    if (order.payment_status === "paid")
      return new Response("already processed", { status: 200 });
    if (!["awaiting", "failed"].includes(order.payment_status)) {
      await logAudit(env, {
        actor_type: "payment_gateway",
        action: "payment_notify_ignored",
        target_type: "order",
        target_id: orderId,
        details: { payment_status: order.payment_status, event_type: eventType },
      });
      return new Response("order not payable", { status: 200 });
    }

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
      await logAudit(env, {
        actor_type: "payment_gateway",
        action: "payment_notify_payment_failed",
        target_type: "order",
        target_id: orderId,
        details: { event_type: eventType, status: payload.status || null },
      });
      return new Response("payment failed", { status: 200 });
    }

    // Stock is checked and taken only now, when the payment is complete
    await ensureNewOrderPushColumn(env).catch(() => {});
    const stockResult = await takeOrderStock(env, orderId);
    const soldOutAfterPayment = stockResult.ok ? null : stockResult;

    const paidUpdate = await runQuery(
      env,
      `
      UPDATE orders
      SET payment_status = 'paid', payment_ref = $1,
          payment_confirmed_at = NOW(),
          kitchen_release_at = NOW() + INTERVAL '2 minutes',
          stock_decremented = ($3::text IS NULL)
      WHERE id = $2 AND payment_status IN ('awaiting', 'failed') -- a retry on Yoco's page can succeed after a failed attempt
      RETURNING id, total_amount, order_type;
    `,
      [paymentRef, orderId, soldOutAfterPayment ? "sold_out" : null],
    );
    const paid = paidUpdate.rows[0];
    if (paid && soldOutAfterPayment) {
      // Someone else's payment got the last stock first - refund this one automatically.
      const names = (soldOutAfterPayment.sold_out || []).filter(Boolean);
      const refund = await cancelAndRefundOrder(env, orderId, "system", `Sold out: ${names.join(", ") || "an item in the order"}`);
      await logAudit(env, {
        actor_type: "payment_gateway",
        action: "payment_after_sold_out_refunded",
        target_type: "order",
        target_id: orderId,
        details: { sold_out: soldOutAfterPayment.sold_out, refund: refund.outcome, error: refund.error || null },
      });
      return new Response("sold out - refunded", { status: 200 });
    }
    if (paid) {
      // A table booking waiting on this pre-order payment is now confirmed.
      await confirmPreorderReservation(context, paid.id);
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
