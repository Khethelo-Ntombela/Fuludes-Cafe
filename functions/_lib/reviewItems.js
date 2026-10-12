// What each reviewed order contained, for showing next to a review ("Ordered
import { runQuery } from "./db.js";

const DRINK_RE = "(drink|beverage|juice|soda|cocktail|alcohol|liquor|wine|beer|smoothie|shake|coffee|\\mtea\\M)";

/** { [order_id]: ["2× Quarter Chicken", "Chakalaka"] } - food only. */
export async function reviewItemsByOrder(env, orderIds) {
  const ids = [...new Set(orderIds.filter((id) => Number.isInteger(Number(id)) && id !== null).map(Number))];
  if (!ids.length) return {};
  const query = (withDrinkType) => `
    SELECT oi.order_id, oi.item_name, SUM(oi.quantity)::int AS qty,
           BOOL_OR(${withDrinkType ? "mi.drink_type IS NOT NULL OR " : ""}
                   ((COALESCE(c.name, '') || ' ' || COALESCE(c.slug, '')) ~* '${DRINK_RE}')) AS is_drink
    FROM order_items oi
    LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
    LEFT JOIN categories c ON c.id = mi.category_id
    WHERE oi.order_id = ANY($1::int[])
    GROUP BY oi.order_id, oi.item_name
    ORDER BY oi.item_name;`;
  const result = await runQuery(env, query(true), [ids])
    .catch(() => runQuery(env, query(false), [ids])); // drink_type column not created yet (migration 008)
  const byOrder = {};
  for (const row of result.rows) {
    if (row.is_drink) continue;
    (byOrder[row.order_id] || (byOrder[row.order_id] = [])).push(row.qty > 1 ? `${row.qty}× ${row.item_name}` : row.item_name);
  }
  return byOrder;
}
