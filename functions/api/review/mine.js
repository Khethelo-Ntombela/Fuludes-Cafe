// GET /api/review/mine - the signed-in customer's own reviews, with their status.
// A rejected review carries the admin's reason, and only a rejected review can be edited.
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { requireCustomer } from "../../_lib/customerAuth.js";
import { ensureReviewColumns } from "../../_lib/reviewColumns.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const { customer, error } = await requireCustomer(request, env);
  if (error) return error;
  try {
    await ensureReviewColumns(env);
    const result = await runQuery(
      env,
      `SELECT id, customer_name, rating, comment, owner_reply, status, rejection_reason, created_at
         FROM reviews
        WHERE customer_id = $1
        ORDER BY created_at DESC
        LIMIT 50;`,
      [customer.id],
    );
    return jsonResponse({
      reviews: result.rows.map((r) => ({ ...r, can_edit: r.status === "rejected" })),
    });
  } catch (err) {
    return jsonResponse({ error: "Failed to load your reviews.", message: err.message }, 500);
  }
}
