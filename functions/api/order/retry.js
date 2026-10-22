import { requireCustomer } from "../../_lib/customerAuth.js";
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { createYocoCheckout } from "../../_lib/yoco.js";
import { priceUnpaidOrders, saveRepricedOrder, UNPAID_ORDER_HOURS } from "../../_lib/repriceOrder.js";
import { getBusinessHours, isOpenNow, isTakingOrdersNow, pickupTimeNeedsChange } from "../../_lib/hours.js";

export async function onRequestPost(context) {
  const { request, env } = context;
  const { customer, error } = await requireCustomer(request, env);
  if (error) return error;
  try {
    const { id } = await request.json();
    const result = await runQuery(
      env,
      "SELECT id, customer_name, customer_phone, order_type, pickup_time, created_at, total_amount, payment_status, (COALESCE((SELECT ((r.reservation_date + r.reservation_time) AT TIME ZONE 'Africa/Johannesburg') FROM customer_reservations r WHERE r.advance_order_id = orders.id LIMIT 1), created_at + make_interval(hours => $3)) < NOW()) AS expired, EXISTS (SELECT 1 FROM customer_reservations r WHERE r.advance_order_id = orders.id) AS is_preorder FROM orders WHERE id = $1 AND customer_id = $2;",
      [Number(id), customer.id, UNPAID_ORDER_HOURS],
    );
    const order = result.rows[0];
    if (!order) return jsonResponse({ error: "Order not found." }, 404);
    if (!["awaiting", "failed"].includes(order.payment_status))
      return jsonResponse(
        { error: "This order is not eligible for payment retry." },
        400,
      );
    if (order.expired) {
      return jsonResponse({ error: "This order has expired (unpaid orders last 24 hours, and a table-booking pre-order ends at the booking time). Please place a new order." }, 410);
    }

    // Same rule as checkout: no paying outside opening hours or in the last hour before closing.
    // (A pre-order tied to a table booking is for a later time, so it can still be paid.)
    if (!order.is_preorder) {
      const hours = await getBusinessHours(env);
      if (!isTakingOrdersNow(hours)) {
        return jsonResponse({
          error: isOpenNow(hours)
            ? "Sorry, you can't pay for this order now. We've stopped taking online orders for today (orders close 1 hour before closing time)."
            : "Sorry, you can't pay for this order now because we're currently closed. Please place a new order when we're open.",
          closed: true,
        }, 503);
      }
      if (order.order_type !== "dine_in" && pickupTimeNeedsChange(order.pickup_time, order.created_at, hours)) {
        return jsonResponse({
          error: "The time you chose is no longer available. Please choose a new time before paying.",
          time_passed: true,
        }, 409);
      }
    }

    // Check today's prices before charging: a special may have started or ended since they went to checkout.
    const priced = (await priceUnpaidOrders(env, [order.id])).get(order.id);
    if (priced?.problems.length) {
      return jsonResponse({ error: `${priced.problems[0]} Please remove this order and place a new one.` }, 409);
    }
    const oldTotal = Number(order.total_amount);
    let newTotal = oldTotal;
    if (priced?.changed) {
      if (!(await saveRepricedOrder(env, order.id, priced))) {
        return jsonResponse({ error: "This order was just updated. Please refresh and try again." }, 409);
      }
      newTotal = priced.total;
    }

    // The payment webhook only confirms orders that are still awaiting.
    if (order.payment_status === "failed") {
      await runQuery(env, "UPDATE orders SET payment_status = 'awaiting' WHERE id = $1 AND payment_status = 'failed';", [order.id]);
    }
    const origin = new URL(request.url).origin;
    return jsonResponse({
      success: true,
      price_changed: newTotal !== oldTotal,
      old_total: oldTotal,
      new_total: newTotal,
      payment: await createYocoCheckout(env, {
        orderId: order.id,
        amount: newTotal,
        itemName: `Fulude's Cafe Order #${order.id}`,
        customerName: order.customer_name,
        customerEmail: customer.email,
        customerPhone: order.customer_phone,
        returnUrl: `${origin}/home.html?payment=success&order_id=${order.id}`,
        cancelUrl: `${origin}/home.html?payment=cancelled&order_id=${order.id}`,
        notifyUrl: `${origin}/api/payment/notify`,
      }),
    });
  } catch (err) {
    return jsonResponse(
      { error: `The payment couldn't be started: ${err.message}`, message: err.message },
      500,
    );
  }
}
