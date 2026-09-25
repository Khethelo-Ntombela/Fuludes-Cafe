/**
 * functions/api/admin/refund.js
 * -----------------------------------------------------------------------
 * POST /api/admin/refund  { order_id, mode? }
 * For a paid order that was cancelled and still needs its money back
 * (refund_needed - e.g. cancelled by staff/admin, or a customer refund
 * that failed):
 *   mode "yoco" (default): refunds it through Yoco's Refund API right from
 *     the app (needs YOCO_SECRET_KEY and the order's Yoco checkout id).
 *   mode "manual": the refund was already done in the Yoco dashboard - just
 *     record it.
 * Every refund is written to the audit log.
 * -----------------------------------------------------------------------
 */
import { requireAdmin } from "../../_lib/auth.js";
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { getRequestIp } from "../../_lib/security.js";
import { logAudit } from "../../_lib/audit.js";
import { refundYocoCheckout } from "../../_lib/yocoRefund.js";
import { ensureYocoTables } from "../../_lib/yoco.js";
import { ensureCancelledByColumn } from "../../_lib/orderCancel.js";

export async function onRequestPost(context) {
  const { request, env } = context;
  const authError = await requireAdmin(request, env);
  if (authError) return authError;
  try {
    const body = await request.json();
    const orderId = Number(body.order_id);
    const mode = body.mode === "manual" ? "manual" : "yoco";
    if (!Number.isInteger(orderId))
      return jsonResponse({ error: "A valid order_id is required." }, 400);

    await ensureCancelledByColumn(env);
    await ensureYocoTables(env).catch(() => {});
    const order = (
      await runQuery(
        env,
        `SELECT id, total_amount, payment_status, payment_ref, yoco_checkout_id, refund_needed, status, customer_id
           FROM orders WHERE id = $1;`,
        [orderId],
      )
    ).rows[0];
    if (!order || order.status !== "Cancelled" || order.payment_status !== "paid" || !order.refund_needed) {
      return jsonResponse({ error: "This order isn't waiting for a refund." }, 400);
    }

    let refundRef = null;
    if (mode === "yoco") {
      // Yoco refunds a checkout (ch_...). payment_ref holds it for normal
      // payments; orders marked paid by hand fall back to yoco_checkout_id.
      const checkoutId = [order.payment_ref, order.yoco_checkout_id].find((r) => r && String(r).startsWith("ch_"));
      if (!checkoutId) {
        return jsonResponse(
          { error: "No Yoco payment is linked to this order, so it can't be refunded from here. Refund it in the Yoco dashboard, then tap \"Already refunded in Yoco\"." },
          400,
        );
      }
      const result = await refundYocoCheckout(env, {
        checkoutId,
        amount: Number(order.total_amount),
        idempotencyKey: `admin-refund-order-${orderId}`,
      });
      if (!result.ok) {
        await runQuery(env, "UPDATE orders SET refund_error = $1 WHERE id = $2;", [result.error, orderId]);
        await logAudit(env, {
          actor_type: "admin",
          actor_role: "admin",
          actor_ip: getRequestIp(request),
          action: "refund_failed_via_yoco",
          target_type: "order",
          target_id: orderId,
          details: { checkout_id: checkoutId, error: result.error },
        });
        return jsonResponse({ error: `Yoco didn't accept the refund: ${result.error}` }, 502);
      }
      refundRef = result.refundId;
    }

    const updated = await runQuery(
      env,
      `
      UPDATE orders
      SET refund_needed = FALSE, refund_processed_at = NOW(),
          payment_status = 'refunded', refund_error = NULL,
          refund_ref = COALESCE($2, refund_ref)
      WHERE id = $1 AND status = 'Cancelled' AND payment_status = 'paid' AND refund_needed = TRUE
      RETURNING id, payment_ref, refund_processed_at;
    `,
      [orderId, refundRef],
    );
    if (!updated.rows.length) {
      return jsonResponse({ error: "This order was just updated - refresh and check again." }, 409);
    }
    await logAudit(env, {
      actor_type: "admin",
      actor_role: "admin",
      actor_ip: getRequestIp(request),
      action: mode === "yoco" ? "refund_processed_via_yoco" : "refund_marked_processed",
      target_type: "order",
      target_id: orderId,
      details: { payment_ref: order.payment_ref, refund_ref: refundRef, amount: Number(order.total_amount) },
    });
    return jsonResponse({ success: true, mode, order: updated.rows[0] });
  } catch (err) {
    return jsonResponse(
      { error: "Failed to process the refund.", message: err.message },
      500,
    );
  }
}
