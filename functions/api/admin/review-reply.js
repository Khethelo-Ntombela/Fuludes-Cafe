// POST /api/admin/review-reply
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { requireAdmin } from "../../_lib/auth.js";
import { sanitizeText } from "../../_lib/security.js";

export async function onRequestPost(context) {
  const { request, env } = context;
  const authError = await requireAdmin(request, env);
  if (authError) return authError;

  try {
    const { review_id, reply } = await request.json();
    const reviewId = parseInt(review_id, 10);
    const replyText = sanitizeText(reply || "", 1000);
    if (!Number.isInteger(reviewId) || !replyText) {
      return jsonResponse(
        { error: "A valid review_id and reply text are required." },
        400,
      );
    }
    // One reply per review, and only once it has been approved.
    const updated = await runQuery(
      env,
      "UPDATE reviews SET owner_reply = $1 WHERE id = $2 AND status = 'approved' AND owner_reply IS NULL RETURNING id;",
      [replyText, reviewId],
    );
    if (!updated.rows.length) {
      return jsonResponse({ error: "This review is not approved yet, or it already has a reply." }, 409);
    }
    return jsonResponse({ success: true });
  } catch (err) {
    return jsonResponse(
      { error: "Failed to save reply.", message: err.message },
      500,
    );
  }
}
