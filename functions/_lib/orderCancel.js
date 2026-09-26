/**
 * functions/_lib/orderCancel.js
 * orders.cancelled_by ('customer' | 'staff' | 'admin') - who cancelled an
 * order, shown in admin Order History (migration 010, also added here on
 * the fly so older databases keep working).
 */
import { runQuery } from "./db.js";

let ready = false;
export async function ensureCancelledByColumn(env) {
  if (ready) return;
  await runQuery(env, "ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_by TEXT;");
  // refund_ref / refund_error come from migration 004 - make sure they exist too.
  await runQuery(env, "ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_ref TEXT;");
  await runQuery(env, "ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_error TEXT;");
  ready = true;
}

/**
 * Puts a cancelled order's items back into stock. Only orders whose stock
 * was actually taken (stock_decremented - set when the payment is
 * confirmed) are restored, and the flag is cleared first in the same
 * statement, so calling this twice can never add the stock back twice.
 * Items with untracked stock (stock_quantity NULL) are left alone.
 */
export async function restoreOrderStock(env, orderId) {
  const claimed = await runQuery(
    env,
    "UPDATE orders SET stock_decremented = FALSE WHERE id = $1 AND stock_decremented = TRUE RETURNING id;",
    [orderId],
  );
  if (!claimed.rows.length) return false;
  await runQuery(
    env,
    `UPDATE menu_items mi
        SET stock_quantity = mi.stock_quantity + x.qty,
            is_available = TRUE
       FROM (SELECT menu_item_id, SUM(quantity)::int AS qty
               FROM order_items
              WHERE order_id = $1 AND menu_item_id IS NOT NULL
              GROUP BY menu_item_id) x
      WHERE mi.id = x.menu_item_id AND mi.stock_quantity IS NOT NULL;`,
    [orderId],
  );
  return true;
}
