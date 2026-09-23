/**
 * functions/_lib/yocoRefund.js
 * -----------------------------------------------------------------------
 * Calls Yoco's real Checkout API to refund a completed payment.
 * https://developer.yoco.com/guides/online-payments/refunding-a-payment
 *
 * Requires env.YOCO_SECRET_KEY - the merchant secret key from the Yoco
 * dashboard (Settings > API Keys). This is DIFFERENT from
 * YOCO_WEBHOOK_SECRET (which only verifies incoming webhooks) and from
 * YOCO_PAYMENT_URL/YOCO_CHECKOUT_URL (which only build the checkout
 * redirect). Without YOCO_SECRET_KEY, refundYocoCheckout() cannot
 * authenticate to Yoco at all and will return { ok: false }.
 *
 * checkoutId must be Yoco's own Checkout id (ch_... / ch_test_...),
 * exactly what's stored in orders.payment_ref from the payment webhook.
 * If payment_ref is not actually a Yoco checkout id (e.g. this
 * environment's webhook sender doesn't send one), the refund call will
 * fail with a 4xx from Yoco - that failure is returned, not thrown, so
 * the caller can fall back to the manual refund_needed flow.
 * -----------------------------------------------------------------------
 */

const YOCO_API_BASE = "https://payments.yoco.com/api";

/**
 * @param {object} env - request env, must contain YOCO_SECRET_KEY
 * @param {object} params
 * @param {string} params.checkoutId - Yoco checkout id to refund (orders.payment_ref)
 * @param {number} params.amount - amount in Rand (will be converted to cents)
 * @param {string} params.idempotencyKey - unique per refund attempt, lets a
 *   retried request be safely resent without risking a double refund
 * @returns {Promise<{ok: true, refundId: string, raw: object} | {ok: false, error: string, status?: number}>}
 */
export async function refundYocoCheckout(env, { checkoutId, amount, idempotencyKey }) {
  if (!env.YOCO_SECRET_KEY) {
    return { ok: false, error: "YOCO_SECRET_KEY is not configured." };
  }
  if (!checkoutId) {
    return { ok: false, error: "Missing Yoco checkout id (payment_ref)." };
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "Invalid refund amount." };
  }

  const amountInCents = Math.round(amount * 100);

  try {
    const res = await fetch(`${YOCO_API_BASE}/checkouts/${encodeURIComponent(checkoutId)}/refund`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.YOCO_SECRET_KEY}`,
        "Content-Type": "application/json",
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: JSON.stringify({ amount: amountInCents }),
    });

    let payload = null;
    try {
      payload = await res.json();
    } catch {
      // Yoco returns 202 Accepted with a body on success; tolerate an
      // empty/non-JSON body rather than treating it as a hard failure.
    }

    // Yoco responds 202 Accepted when the refund request is received
    // and is being processed (refund completion itself is async).
    if (res.status === 202 || res.ok) {
      return {
        ok: true,
        refundId: payload?.id || payload?.refund?.id || null,
        raw: payload,
      };
    }

    return {
      ok: false,
      status: res.status,
      error: payload?.message || payload?.error || `Yoco refund failed with status ${res.status}.`,
    };
  } catch (err) {
    return { ok: false, error: err.message || "Network error calling Yoco refund API." };
  }
}
