/**
 * functions/_lib/stock.js
 * -----------------------------------------------------------------------
 * Stock is checked and deducted ONLY when a payment is completed (the Yoco
 * payment webhook). Nothing is reserved at cart, checkout or while the
 * customer is on Yoco's page.
 *
 * takeOrderStock is all-or-nothing and race-safe: when several customers
 * pay for the last items at the same time, only the first completed
 * payment gets the stock; for the others it returns ok:false and the
 * webhook refunds them automatically.
 * orders.stock_decremented = "this order's stock has been taken".
 * -----------------------------------------------------------------------
 */
import { runQuery } from "./db.js";

/**
 * Takes the stock for a just-paid order. Returns { ok: true } or
 * { ok: false, sold_out: [names] }. Calling it again for the same order
 * never takes the stock twice.
 */
export async function takeOrderStock(env, orderId) {
  // Claim the order first - a repeated webhook for it can't take stock twice.
  const claimed = await runQuery(
    env,
    "UPDATE orders SET stock_decremented = TRUE WHERE id = $1 AND stock_decremented = FALSE RETURNING id;",
    [orderId],
  );
  if (!claimed.rows.length) return { ok: true }; // already taken

  // Take every tracked dish in one statement. The stock check sits in the
  // UPDATE itself, so two payments racing for the last one can't both get it.
  const res = await runQuery(
    env,
    `WITH need AS (
       SELECT menu_item_id, SUM(quantity)::int AS qty
         FROM order_items
        WHERE order_id = $1 AND menu_item_id IS NOT NULL
        GROUP BY menu_item_id
     ),
     tracked AS (
       SELECT n.menu_item_id, n.qty FROM need n
         JOIN menu_items mi ON mi.id = n.menu_item_id
        WHERE mi.stock_quantity IS NOT NULL
     ),
     taken AS (
       UPDATE menu_items mi
          SET stock_quantity = mi.stock_quantity - t.qty,
              is_available = (mi.stock_quantity - t.qty > 0)
         FROM tracked t
        WHERE mi.id = t.menu_item_id AND mi.stock_quantity >= t.qty
       RETURNING mi.id, t.qty
     )
     SELECT (SELECT COUNT(*)::int FROM tracked) AS tracked_count,
            COALESCE((SELECT json_agg(json_build_object('id', id, 'qty', qty)) FROM taken), '[]'::json) AS taken;`,
    [orderId],
  );
  const { tracked_count: trackedCount, taken } = res.rows[0];
  const takenList = typeof taken === "string" ? JSON.parse(taken) : taken || [];
  if (takenList.length >= trackedCount) return { ok: true };

  // Not enough of something: give back what was taken for this order.
  for (const t of takenList) {
    await runQuery(env, "UPDATE menu_items SET stock_quantity = stock_quantity + $1, is_available = TRUE WHERE id = $2;", [t.qty, t.id]);
  }
  await runQuery(env, "UPDATE orders SET stock_decremented = FALSE WHERE id = $1;", [orderId]);
  const short = await runQuery(
    env,
    `SELECT DISTINCT mi.name FROM order_items oi
       JOIN menu_items mi ON mi.id = oi.menu_item_id
      WHERE oi.order_id = $1 AND mi.stock_quantity IS NOT NULL AND NOT (mi.id = ANY($2::int[]));`,
    [orderId, takenList.map((t) => t.id)],
  );
  return { ok: false, sold_out: short.rows.map((r) => r.name) };
}
