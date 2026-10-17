import { requireCustomer } from "../../_lib/customerAuth.js";
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { createYocoCheckout } from "../../_lib/yoco.js";
import { priceUnpaidOrders, saveRepricedOrder, UNPAID_ORDER_HOURS } from "../../_lib/repriceOrder.js";

export async function onRequestPost(context) {
  const { request, env } = context;
  const { customer, error } = await requireCustomer(request, env);
  if (error) return error;
  try {
    const { id } = await request.json();
    const result = await runQuery(
      env,
      "SELECT id, customer_name, customer_phone, total_amount, payment_status, (created_at < NOW() - make_interval(hours => $3) AND NOT EXISTS (SELECT 1 FROM customer_reservations r WHERE r.advance_order_id = orders.id)) AS expired FROM orders WHERE id = $1 AND customer_id = $2;",
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
      return jsonResponse({ error: `This order is more than ${UNPAID_ORDER_HOURS} hours old and has expired. Please place a new order.` }, 410);
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
