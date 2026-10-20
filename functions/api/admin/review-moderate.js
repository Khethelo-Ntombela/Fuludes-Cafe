// POST /api/admin/review-moderate
// Admins can approve, reject (with a reason the customer will see) or delete a review.
// They cannot edit what a customer wrote: after a rejection the customer edits their own review.
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { requireAdmin } from "../../_lib/auth.js";
import { sanitizeText } from "../../_lib/security.js";
import { ensureReviewColumns } from "../../_lib/reviewColumns.js";

export async function onRequestPost(context) {
  const { request, env } = context;
  const authError = await requireAdmin(request, env);
  if (authError) return authError;

  try {
    await ensureReviewColumns(env);
    const body = await request.json();
    const { review_id, action } = body;
    const id = parseInt(review_id, 10);
    if (!Number.isInteger(id) || !action)
      return jsonResponse({ error: "review_id and action are required." }, 400);

    if (action === "approve") {
      await runQuery(
        env,
        "UPDATE reviews SET status='approved', rejection_reason = NULL WHERE id = $1;",
        [id],
      );
      return jsonResponse({ success: true });
    }
    if (action === "reject") {
      const reason = sanitizeText(body.reason || "", 300);
      if (reason.length < 3) {
        return jsonResponse(
          { error: "Please give a reason (at least 3 characters). The customer will see it." },
          400,
        );
      }
      const updated = await runQuery(
        env,
        "UPDATE reviews SET status='rejected', rejection_reason = $2 WHERE id = $1 AND status = 'pending' RETURNING id;",
        [id, reason],
      );
      if (!updated.rows.length) {
        return jsonResponse({ error: "Only a review that is waiting for approval can be rejected." }, 409);
      }
      return jsonResponse({ success: true });
    }
    if (action === "delete") {
      await runQuery(env, "DELETE FROM reviews WHERE id = $1;", [id]);
      return jsonResponse({ success: true });
    }
    return jsonResponse({ error: "Unknown action." }, 400);
  } catch (err) {
    return jsonResponse(
      { error: "Failed to moderate review.", message: err.message },
      500,
    );
  }
}
