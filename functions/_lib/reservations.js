/**
 * functions/_lib/reservations.js
 * -----------------------------------------------------------------------
 * Table bookings with a food pre-order.
 *
 * A booking made with "pre-order food" starts as status 'AwaitingPayment':
 * it's hidden from the admin until the pre-order is actually PAID (the
 * Yoco payment webhook, or admin "Mark paid"), then it becomes
 * 'Confirmed' automatically - no manual confirmation needed.
 *
 * If the admin cancels a prepaid booking, its pre-order is cancelled and
 * refunded through Yoco (cancelAndRefundOrder).
 * -----------------------------------------------------------------------
 */
import { runQuery } from "./db.js";
import { logAudit } from "./audit.js";
import { queuePush } from "./push.js";
import { refundYocoCheckout } from "./yocoRefund.js";
import { ensureYocoTables } from "./yoco.js";
import { ensureCancelledByColumn, restoreOrderStock } from "./orderCancel.js";

/** Called once an order is paid: confirms the booking it pre-orders for (if any) and tells the admin. */
export async function confirmPreorderReservation(context, orderId) {
  const { env } = context;
  try {
    const res = await runQuery(
      env,
      `UPDATE customer_reservations SET status = 'Confirmed'
        WHERE advance_order_id = $1 AND status = 'AwaitingPayment'
        RETURNING id, customer_name, party_size,
                  to_char(reservation_date, 'DD Mon') AS day, to_char(reservation_time, 'HH24:MI') AS time;`,
      [orderId],
    );
    const r = res.rows[0];
    if (!r) return null;
    queuePush(context, { roles: ["admin"] }, {
      title: "New reservation (pre-order paid)",
      body: `${r.customer_name} · ${r.party_size} guest${r.party_size > 1 ? "s" : ""} · ${r.day} ${r.time}`,
      url: "/admin.html#reservations",
      tag: `reservation-${r.id}`,
    });
    return r;
  } catch {
    return null; // never block the payment confirmation itself
  }
}

/**
 * Cancels an order and, when it was paid, refunds it through Yoco.
 * Returns { outcome: "refunded" | "refund_needed" | "not_paid" | "none", error? }.
 * A failed refund leaves refund_needed = TRUE so it shows in admin Order
 * History with the "Refund via Yoco" button.
 */
export async function cancelAndRefundOrder(env, orderId, cancelledBy) {
  await ensureCancelledByColumn(env);
  await ensureYocoTables(env).catch(() => {});
  const order = (
    await runQuery(
      env,
      "SELECT id, total_amount, status, payment_status, payment_ref, yoco_checkout_id, refund_needed FROM orders WHERE id = $1;",
      [orderId],
    )
  ).rows[0];
  if (!order) return { outcome: "none" };
  if (order.payment_status === "refunded") return { outcome: "refunded" };

  if (order.payment_status !== "paid") {
    await runQuery(
      env,
      "UPDATE orders SET status = 'Cancelled', cancelled_by = $2 WHERE id = $1 AND status <> 'Cancelled';",
      [orderId, cancelledBy],
    );
    await restoreOrderStock(env, orderId); // (only if its stock was ever taken)
    return { outcome: "not_paid" };
  }

  await runQuery(
    env,
    `UPDATE orders SET status = 'Cancelled', cancelled_by = COALESCE(cancelled_by, $2), refund_needed = TRUE
      WHERE id = $1 AND payment_status = 'paid';`,
    [orderId, cancelledBy],
  );
  await restoreOrderStock(env, orderId); // cancelled pre-order: its items go back into stock

  const checkoutId = [order.payment_ref, order.yoco_checkout_id].find((r) => r && String(r).startsWith("ch_"));
  if (!checkoutId) {
    return { outcome: "refund_needed", error: "No Yoco payment is linked to this order - refund it from Order History." };
  }
  const result = await refundYocoCheckout(env, {
    checkoutId,
    amount: Number(order.total_amount),
    idempotencyKey: `cancel-refund-order-${orderId}`,
  });
  if (!result.ok) {
    await runQuery(env, "UPDATE orders SET refund_error = $1 WHERE id = $2;", [result.error, orderId]);
    await logAudit(env, {
      actor_type: cancelledBy,
      actor_role: cancelledBy,
      action: "refund_failed_via_yoco",
      target_type: "order",
      target_id: orderId,
      details: { checkout_id: checkoutId, error: result.error },
    });
    return { outcome: "refund_needed", error: result.error };
  }
  await runQuery(
    env,
    `UPDATE orders SET payment_status = 'refunded', refund_needed = FALSE, refund_processed_at = NOW(),
            refund_ref = $1, refund_error = NULL
      WHERE id = $2;`,
    [result.refundId, orderId],
  );
  await logAudit(env, {
    actor_type: cancelledBy,
    actor_role: cancelledBy,
    action: "refund_processed_via_yoco",
    target_type: "order",
    target_id: orderId,
    details: { payment_ref: checkoutId, refund_ref: result.refundId, amount: Number(order.total_amount) },
  });
  return { outcome: "refunded" };
}
