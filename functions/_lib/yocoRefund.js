// Calls Yoco's real Checkout API to refund a completed payment

const YOCO_API_BASE = "https://payments.yoco.com/api";

// @param {object} env - request env, must contain YOCO_SECRET_KEY
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
