// POST /api/admin/order-status
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { requireAdmin } from "../../_lib/auth.js";
import { getRequestIp } from "../../_lib/security.js";
import { queueOrderStatusPush } from "../../_lib/push.js";
import { ensureCancelledByColumn, restoreOrderStock } from "../../_lib/orderCancel.js";
import { logAudit } from "../../_lib/audit.js";
import { ensureScheduleColumns } from "../../_lib/scheduledOrders.js";

const ALLOWED_STATUSES = [
  "New",
  "Preparing",
  "Ready",
  "Collection",
  "Delivery",
  "Completed",
  "Cancelled",
];

const FORWARD_TRANSITIONS = {
  New: ["Preparing"],
  Preparing: ["Ready"],
  Ready: ["Collection", "Delivery"],
  Collection: ["Completed"],
  Delivery: ["Completed"],
  Completed: [],
  Cancelled: [],
};

function normalizeStatus(value) {
  if (typeof value !== "string") return "";
  const status = value.trim().toLowerCase().replace(/[_-]+/g, " ");
  const aliases = {
    new: "New",
    pending: "New",
    preparing: "Preparing",
    acknowledged: "Preparing",
    ready: "Ready",
    collection: "Collection",
    collected: "Collection",
    delivery: "Delivery",
    "out for delivery": "Delivery",
    completed: "Completed",
    complete: "Completed",
    cancelled: "Cancelled",
    canceled: "Cancelled",
  };
  return aliases[status] || value.trim();
}

function normalizeFulfillmentMode(value) {
  if (typeof value !== "string") return "";
  const mode = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["collection", "pickup", "collected"].includes(mode)) return "collection";
  if (["delivery", "deliver"].includes(mode)) return "delivery";
  if (["dine_in", "dine in", "dine-in", "table"].includes(mode)) {
    return "dine_in";
  }
  return mode;
}

function isValidTransition(currentStatus, nextStatus) {
  if (currentStatus === nextStatus) return true;
  if (nextStatus === "Cancelled") {
    return ["New", "Preparing", "Ready", "Collection", "Delivery"].includes(
      currentStatus,
    );
  }
  return (FORWARD_TRANSITIONS[currentStatus] || []).includes(nextStatus);
}

function transitionError(currentStatus, nextStatus) {
  if (isValidTransition(currentStatus, nextStatus)) return null;
  if (["Completed", "Cancelled"].includes(currentStatus)) {
    return `Orders in ${currentStatus} cannot be moved.`;
  }
  return `Order ${currentStatus} can only move to ${(
    FORWARD_TRANSITIONS[currentStatus] || []
  ).join(" or ")}.`;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const authError = await requireAdmin(request, env);
  if (authError) return authError;
  const requestIp = getRequestIp(request);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body." }, 400);
  }

  const orderId = Number(body.order_id);
  const status = normalizeStatus(body.status);
  if (!Number.isInteger(orderId) || !ALLOWED_STATUSES.includes(status)) {
    return jsonResponse(
      { error: "A valid order_id and status are required." },
      400,
    );
  }

  const requestedMode = normalizeFulfillmentMode(
    body.order_type || body.fulfillment_mode,
  );
  if (
    requestedMode &&
    !["collection", "delivery", "dine_in"].includes(requestedMode)
  ) {
    return jsonResponse({ error: "Invalid order type." }, 400);
  }

  try {
    const orderResult = await runQuery(
      env,
      `
        SELECT id, status, order_type, delivery_address, payment_status
        FROM orders
        WHERE id = $1;
      `,
      [orderId],
    );
    const order = orderResult.rows[0];
    if (!order) {
      return jsonResponse({ error: "Order not found." }, 404);
    }

    const currentStatus = normalizeStatus(order.status);
    const nextStatus = status;
    const error = transitionError(currentStatus, nextStatus);
    if (error) return jsonResponse({ error }, 400);

    let nextOrderType = order.order_type || "collection";
    if (nextStatus === "Collection") nextOrderType = "collection";
    if (nextStatus === "Delivery") nextOrderType = "delivery";
    if (requestedMode) nextOrderType = requestedMode;

    if (
      nextStatus === "Delivery" &&
      nextOrderType === "delivery" &&
      !(order.delivery_address || "").trim()
    ) {
      return jsonResponse(
        { error: "A delivery address is required for delivery orders." },
        400,
      );
    }

    await ensureCancelledByColumn(env);
    await ensureScheduleColumns(env);
    const updateResult = await runQuery(
      env,
      `
        UPDATE orders
        SET status = $1,
            preparing_at = CASE WHEN $1 = 'Preparing' AND preparing_at IS NULL THEN NOW() ELSE preparing_at END,
            out_for_delivery_at = CASE WHEN $1 = 'Delivery' AND out_for_delivery_at IS NULL THEN NOW() ELSE out_for_delivery_at END,
            cancelled_by = CASE WHEN $1 = 'Cancelled' THEN 'admin' ELSE cancelled_by END,
            order_type = CASE
              WHEN $1 IN ('Collection', 'Delivery') THEN $4
              ELSE order_type
            END,
            refund_needed = CASE
              WHEN $1 = 'Cancelled' AND payment_status = 'paid' THEN TRUE
              ELSE refund_needed
            END
        WHERE id = $2 AND status = $3
        RETURNING id, status, order_type, delivery_address, customer_id;
      `,
      [nextStatus, orderId, currentStatus, nextOrderType],
    );

    if (updateResult.rows.length === 0) {
      return jsonResponse(
        { error: "This order was already updated. Refresh and try again." },
        409,
      );
    }

    const updatedOrder = updateResult.rows[0];
    // A cancelled order's items go back into stock.
    if (nextStatus === "Cancelled") await restoreOrderStock(env, orderId);
    // Only the two outcomes that matter for an audit trail get logged -
    // the in-between moves (Preparing/Ready/Collection/Delivery) don't.
    if (nextStatus === "Completed") {
      await logAudit(env, {
        actor_type: "admin",
        actor_role: "admin",
        actor_ip: requestIp,
        action: "order_completed",
        target_type: "order",
        target_id: orderId,
        details: {},
      });
    } else if (nextStatus === "Cancelled") {
      await logAudit(env, {
        actor_type: "admin",
        actor_role: "admin",
        actor_ip: requestIp,
        action: "order_cancelled",
        target_type: "order",
        target_id: orderId,
        details: { previousStatus: currentStatus },
      });
    }

    queueOrderStatusPush(context, updatedOrder.customer_id, updatedOrder.id, updatedOrder.status);

    return jsonResponse({
      success: true,
      order: {
        id: updatedOrder.id,
        status: updatedOrder.status,
        order_type: updatedOrder.order_type,
        delivery_address: updatedOrder.delivery_address,
      },
    });
  } catch (err) {
    return jsonResponse(
      { error: "Failed to update order status.", message: err.message },
      500,
    );
  }
}
