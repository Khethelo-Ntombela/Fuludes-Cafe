/**
 * functions/api/admin/review-moderate.js
 * -----------------------------------------------------------------------
 * POST /api/admin/review-moderate  { review_id, action }
 * action: 'approve' | 'reject' | 'delete'
 * Requires admin auth.
 * -----------------------------------------------------------------------
 */
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { requireAdmin } from "../../_lib/auth.js";

export async function onRequestPost(context) {
  const { request, env } = context;
  const authError = await requireAdmin(request, env);
  if (authError) return authError;

  try {
    const { review_id, action } = await request.json();
    const id = parseInt(review_id, 10);
    if (!Number.isInteger(id) || !action)
      return jsonResponse({ error: "review_id and action are required." }, 400);

    if (action === "approve") {
      await runQuery(
        env,
        "UPDATE reviews SET status='approved' WHERE id = $1;",
        [id],
      );
      return jsonResponse({ success: true });
    }
    if (action === "reject") {
      await runQuery(
        env,
        "UPDATE reviews SET status='rejected' WHERE id = $1;",
        [id],
      );
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
