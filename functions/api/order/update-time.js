import { requireCustomer } from "../../_lib/customerAuth.js";
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { UNPAID_ORDER_HOURS } from "../../_lib/repriceOrder.js";
import { getBusinessHours, isOpenNow, isTakingOrdersNow, validatePickupSlot } from "../../_lib/hours.js";
import { ensureScheduleColumns, scheduledForFromPickup } from "../../_lib/scheduledOrders.js";

export async function onRequestPost(context) {
  const { request, env } = context;
  const { customer, error } = await requireCustomer(request, env);
  if (error) return error;
  try {
    const body = await request.json();
    const id = Number(body.id);
    const pickupTime = String(body.pickup_time || "").trim();
    const isAsap = pickupTime === "As soon as possible";
    if (!isAsap && !/^At \d{1,2}:\d{2} - \d{1,2}:\d{2}$/.test(pickupTime)) {
      return jsonResponse({ error: "Please choose a time from the list." }, 400);
    }
    await ensureScheduleColumns(env);
    const result = await runQuery(
      env,
      "SELECT id, order_type, payment_status, (created_at + make_interval(hours => $3) < NOW()) AS expired, EXISTS (SELECT 1 FROM customer_reservations r WHERE r.advance_order_id = orders.id) AS is_preorder FROM orders WHERE id = $1 AND customer_id = $2;",
      [id, customer.id, UNPAID_ORDER_HOURS],
    );
    const order = result.rows[0];
    if (!order) return jsonResponse({ error: "Order not found." }, 404);
    if (!["awaiting", "failed"].includes(order.payment_status)) {
      return jsonResponse({ error: "The time can only be changed before the order is paid." }, 400);
    }
    if (order.expired) {
      return jsonResponse({ error: "This order has expired. Please place a new order." }, 410);
    }
    if (order.is_preorder || order.order_type === "dine_in") {
      return jsonResponse({ error: "The time of this order follows your table booking." }, 400);
    }
    const hours = await getBusinessHours(env);
    if (!isTakingOrdersNow(hours)) {
      return jsonResponse({
        error: isOpenNow(hours)
          ? "Sorry, we've stopped taking online orders for today (orders close 1 hour before closing time)."
          : "Sorry, we're currently closed. Please place a new order when we're open.",
        closed: true,
      }, 503);
    }
    const slotError = validatePickupSlot(pickupTime, hours);
    if (slotError) return jsonResponse({ error: slotError }, 400);

    const scheduledFor = isAsap ? null : scheduledForFromPickup(pickupTime);
    const updated = await runQuery(
      env,
      "UPDATE orders SET pickup_time = $1, scheduled_for = $2 WHERE id = $3 AND customer_id = $4 AND payment_status IN ('awaiting', 'failed') RETURNING id;",
      [pickupTime, scheduledFor ? scheduledFor.toISOString() : null, id, customer.id],
    );
    if (!updated.rows[0]) return jsonResponse({ error: "This order was just updated. Please refresh and try again." }, 409);
    return jsonResponse({ success: true, pickup_time: pickupTime });
  } catch (err) {
    return jsonResponse({ error: `The time couldn't be updated: ${err.message}`, message: err.message }, 500);
  }
}
