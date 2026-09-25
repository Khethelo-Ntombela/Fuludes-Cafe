/**
 * functions/api/admin/mark-paid.js
 * -----------------------------------------------------------------------
 * POST /api/admin/mark-paid  { id, payment_ref? }
 * Recovery for "the customer paid on Yoco but the order is still waiting
 * for payment" (e.g. the payment notification never arrived). The admin
 * checks the payment in the Yoco dashboard first, then this does what the
 * payment webhook would have done: marks the order paid, takes the stock,
 * sends it to the kitchen (after the usual 2-minute cancel window) and
 * notifies staff. Every use is written to the audit log.
 * -----------------------------------------------------------------------
 */
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { requireAdmin } from "../../_lib/auth.js";
import { logAudit } from "../../_lib/audit.js";
import { sanitizeText, getRequestIp } from "../../_lib/security.js";
import { queuePush } from "../../_lib/push.js";
import { ensureYocoTables } from "../../_lib/yoco.js";

export async function onRequestPost(context) {
  const { request, env } = context;
  const authError = await requireAdmin(request, env);
  if (authError) return authError;

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body." }, 400);
  }
  const id = parseInt(body.id, 10);
  if (!Number.isInteger(id)) return jsonResponse({ error: "A valid order id is required." }, 400);

  try {
    await ensureYocoTables(env).catch(() => {});
    const order = (
      await runQuery(env, "SELECT id, total_amount, order_type, payment_status, yoco_checkout_id FROM orders WHERE id = $1;", [id])
    ).rows[0];
    if (!order) return jsonResponse({ error: "Order not found." }, 404);
    if (!["awaiting", "failed"].includes(order.payment_status)) {
      return jsonResponse({ error: `Order #${id} isn't waiting for payment (it's "${order.payment_status}").` }, 400);
    }

    // The Yoco checkout id keeps automatic refunds working for this order.
    const paymentRef = sanitizeText(body.payment_ref || "", 100) || order.yoco_checkout_id || "manual";

    const updated = await runQuery(
      env,
      `UPDATE orders
          SET payment_status = 'paid', payment_ref = $1, payment_confirmed_at = NOW(),
              kitchen_release_at = NOW() + INTERVAL '2 minutes', stock_decremented = TRUE
        WHERE id = $2 AND payment_status IN ('awaiting', 'failed')
        RETURNING id;`,
      [paymentRef, id],
    );
    if (!updated.rows.length) return jsonResponse({ error: "This order was just updated - refresh and check again." }, 409);

    // Take the stock the payment webhook would have taken (never below zero).
    const items = await runQuery(
      env,
      "SELECT menu_item_id, SUM(quantity)::int AS quantity FROM order_items WHERE order_id = $1 AND menu_item_id IS NOT NULL GROUP BY menu_item_id;",
      [id],
    );
    for (const item of items.rows) {
      await runQuery(
        env,
        `UPDATE menu_items
            SET stock_quantity = GREATEST(stock_quantity - $1, 0),
                is_available = (GREATEST(stock_quantity - $1, 0) > 0)
          WHERE id = $2 AND stock_quantity IS NOT NULL;`,
        [item.quantity, item.menu_item_id],
      );
    }

    await logAudit(env, {
      actor_type: "admin",
      actor_role: "admin",
      actor_ip: getRequestIp(request),
      action: "order_marked_paid",
      target_type: "order",
      target_id: id,
      details: { payment_ref: paymentRef, total_amount: Number(order.total_amount) },
    });

    const type = order.order_type === "delivery" ? "Delivery" : order.order_type === "dine_in" ? "Dine in" : "Collection";
    queuePush(context, { roles: ["admin", "staff"] }, {
      title: `New paid order #${id}`,
      body: `${type} · R${Number(order.total_amount).toFixed(2)}`,
      url: { admin: "/admin.html#orders", staff: "/staff.html" },
      tag: `order-${id}`,
    });

    return jsonResponse({ success: true });
  } catch (err) {
    return jsonResponse({ error: "Couldn't mark the order as paid.", message: err.message }, 500);
  }
}
