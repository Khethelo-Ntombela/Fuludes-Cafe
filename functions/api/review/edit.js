// POST /api/review/edit - a customer edits their own review.
// Allowed ONLY after an admin has rejected it. Saving sends it back for approval (status 'pending')
// and clears the rejection reason. A pending or approved review cannot be edited.
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { requireCustomer } from "../../_lib/customerAuth.js";
import { sanitizeText, isValidName, VALIDATION_MESSAGES } from "../../_lib/security.js";
import { ensureReviewColumns } from "../../_lib/reviewColumns.js";

export async function onRequestPost(context) {
  const { request, env } = context;
  const { customer, error } = await requireCustomer(request, env);
  if (error) return error;

  try {
    await ensureReviewColumns(env);
    const body = await request.json();
    const id = parseInt(body.review_id, 10);
    const customerName = sanitizeText(body.customer_name || "", 100);
    const rating = parseInt(body.rating, 10);
    const comment = sanitizeText(body.comment || "", 1000);

    if (!Number.isInteger(id)) return jsonResponse({ error: "review_id is required." }, 400);
    if (customerName && !isValidName(customerName)) return jsonResponse({ error: VALIDATION_MESSAGES.name }, 400);
    if (!customerName || !comment || !Number.isInteger(rating) || rating < 1 || rating > 5) {
      return jsonResponse({ error: "Please provide your name, a comment, and a rating from 1-5." }, 400);
    }
    if (comment.length < 3) return jsonResponse({ error: "Please write a short comment about your visit." }, 400);

    const found = await runQuery(env, "SELECT status FROM reviews WHERE id = $1 AND customer_id = $2;", [id, customer.id]);
    const review = found.rows[0];
    if (!review) return jsonResponse({ error: "Review not found." }, 404);
    if (review.status === "approved") {
      return jsonResponse({ error: "This review has been approved and can no longer be edited.", code: "approved" }, 403);
    }
    if (review.status !== "rejected") {
      return jsonResponse({ error: "This review is waiting for approval. You can edit it only if it is rejected.", code: "pending" }, 403);
    }

    const updated = await runQuery(
      env,
      `UPDATE reviews
          SET customer_name = $1, rating = $2, comment = $3, status = 'pending', rejection_reason = NULL
        WHERE id = $4 AND customer_id = $5 AND status = 'rejected'
        RETURNING id;`,
      [customerName, rating, comment, id, customer.id],
    );
    if (!updated.rows.length) {
      return jsonResponse({ error: "This review can't be edited right now." }, 409);
    }
    return jsonResponse({ success: true, message: "Thank you - your review was updated and sent for approval again." });
  } catch (err) {
    return jsonResponse({ error: "Failed to update review.", message: err.message }, 500);
  }
}
