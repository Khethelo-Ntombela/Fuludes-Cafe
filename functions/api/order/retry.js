import { requireCustomer } from "../../_lib/customerAuth.js";
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { createYocoCheckout } from "../../_lib/yoco.js";

export async function onRequestPost(context) {
  const { request, env } = context;
  const { customer, error } = await requireCustomer(request, env);
  if (error) return error;
  try {
    const { id } = await request.json();
    const result = await runQuery(
      env,
      "SELECT id, customer_name, customer_phone, total_amount, payment_status FROM orders WHERE id = $1 AND customer_id = $2;",
      [Number(id), customer.id],
    );
    const order = result.rows[0];
    if (!order) return jsonResponse({ error: "Order not found." }, 404);
    if (!["awaiting", "failed"].includes(order.payment_status))
      return jsonResponse(
        { error: "This order is not eligible for payment retry." },
        400,
      );
    // The payment webhook only confirms orders that are still awaiting.
    if (order.payment_status === "failed") {
      await runQuery(env, "UPDATE orders SET payment_status = 'awaiting' WHERE id = $1 AND payment_status = 'failed';", [order.id]);
    }
    const origin = new URL(request.url).origin;
    return jsonResponse({
      success: true,
      payment: await createYocoCheckout(env, {
        orderId: order.id,
        amount: Number(order.total_amount),
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
