// POST /api/order/discard
import { requireCustomer } from "../../_lib/customerAuth.js";
import { runQuery, jsonResponse } from "../../_lib/db.js";

export async function onRequestPost(context) {
  const { request, env } = context;
  const { customer, error } = await requireCustomer(request, env);
  if (error) return error;
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body." }, 400);
  }
  const id = parseInt(body.id, 10);
  if (!Number.isInteger(id)) return jsonResponse({ error: "A valid order id is required." }, 400);
  try {
    const removed = await runQuery(
      env,
      `DELETE FROM orders
        WHERE id = $1 AND customer_id = $2 AND payment_status IN ('awaiting', 'failed')
        RETURNING id;`,
      [id, customer.id],
    );
    if (!removed.rows.length) {
      return jsonResponse({ error: "That order can't be removed (it may already be paid)." }, 400);
    }
    return jsonResponse({ success: true });
  } catch (err) {
    return jsonResponse({ error: "Couldn't remove the order.", message: err.message }, 500);
  }
}
