// GET /api/admin/reviews
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { requireAdmin } from "../../_lib/auth.js";
import { reviewItemsByOrder } from "../../_lib/reviewItems.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const authError = await requireAdmin(request, env);
  if (authError) return authError;
  try {
    const result = await runQuery(
      env,
      `SELECT id, customer_name, rating, comment, owner_reply, status, order_id, created_at
         FROM reviews
        ORDER BY (status = 'pending') DESC, created_at DESC
        LIMIT 300;`,
    );
    const items = await reviewItemsByOrder(env, result.rows.map((r) => r.order_id));
    return jsonResponse({
      reviews: result.rows.map((r) => ({ ...r, items: items[r.order_id] || [] })),
    });
  } catch (err) {
    return jsonResponse({ error: "Failed to load reviews.", message: err.message }, 500);
  }
}
