// POST /api/admin/review-moderate
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { requireAdmin } from "../../_lib/auth.js";
import { sanitizeText } from "../../_lib/security.js";

export async function onRequestPost(context) {
  const { request, env } = context;
  const authError = await requireAdmin(request, env);
  if (authError) return authError;

  try {
    const body = await request.json();
    const { review_id, action } = body;
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
    if (action === "edit") {
      const name = sanitizeText(body.customer_name || "", 100);
      const comment = sanitizeText(body.comment || "", 1000);
      const rating = parseInt(body.rating, 10);
      if (!name || !comment || !(rating >= 1 && rating <= 5))
        return jsonResponse({ error: "Name, comment and a rating from 1 to 5 are required." }, 400);
      await runQuery(env, "UPDATE reviews SET customer_name = $1, comment = $2, rating = $3 WHERE id = $4;", [name, comment, rating, id]);
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
