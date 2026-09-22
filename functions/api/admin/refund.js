import { requireAdmin } from "../../_lib/auth.js";
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { getRequestIp } from "../../_lib/security.js";
import { logAudit } from "../../_lib/audit.js";

export async function onRequestPost(context) {
  const { request, env } = context;
  const authError = await requireAdmin(request, env);
  if (authError) return authError;
  try {
    const body = await request.json();
    const orderId = Number(body.order_id);
    if (!Number.isInteger(orderId))
      return jsonResponse({ error: "A valid order_id is required." }, 400);
    const result = await runQuery(
      env,
      `
      UPDATE orders
      SET refund_needed = FALSE, refund_processed_at = NOW()
      WHERE id = $1 AND status = 'Cancelled' AND payment_status = 'paid' AND refund_needed = TRUE
      RETURNING id, payment_ref, refund_processed_at;
    `,
      [orderId],
    );
    if (!result.rows.length)
      return jsonResponse(
        { error: "Order is not awaiting a manual refund." },
        400,
      );
    await logAudit(env, {
      actor_type: "admin",
      actor_role: "admin",
      actor_ip: getRequestIp(request),
      action: "refund_marked_processed",
      target_type: "order",
      target_id: orderId,
      details: { payment_ref: result.rows[0].payment_ref },
    });
    return jsonResponse({ success: true, order: result.rows[0] });
  } catch (err) {
    return jsonResponse(
      { error: "Failed to mark refund processed.", message: err.message },
      500,
    );
  }
}
