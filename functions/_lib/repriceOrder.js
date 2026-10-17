// Works out what an UNPAID order would cost at today's prices (specials, extras, stock included).
//
// Used in two places:
//   - api/order/retry.js: before the customer pays again, the order is re-priced and the new total saved,
//     so they are charged today's price and not the price from when they first went to checkout.
//   - api/admin/orders.js: the "Orders awaiting payment" list shows today's price (display only, nothing saved).
//
// Unpaid orders older than UNPAID_ORDER_HOURS are treated as expired: customers and admins no longer see them
// and they cannot be paid again.
import { runQuery } from "./db.js";

export const UNPAID_ORDER_HOURS = 24;

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function specialIsActive(menu, now) {
  if (menu.special_price === null || menu.special_price === undefined) return false;
  const starts = menu.special_starts_at ? new Date(menu.special_starts_at) : null;
  const ends = menu.special_ends_at ? new Date(menu.special_ends_at) : null;
  return (!starts || now >= starts) && (!ends || now < ends);
}

/**
 * @returns Map(orderId -> { stored_total, total, changed, items, problems })
 *   items: the order's lines with today's item_price, extras and subtotal
 *   problems: things that stop it being paid (dish removed, sold out, not enough stock)
 */
export async function priceUnpaidOrders(env, orderIds) {
  const result = new Map();
  if (!orderIds.length) return result;

  const [ordersRes, itemsRes] = await Promise.all([
    runQuery(env, "SELECT id, total_amount, delivery_fee FROM orders WHERE id = ANY($1::int[]);", [orderIds]),
    runQuery(
      env,
      `SELECT id, order_id, menu_item_id, item_name, item_price, quantity, spice_level, extras, subtotal
         FROM order_items WHERE order_id = ANY($1::int[]) ORDER BY id ASC;`,
      [orderIds],
    ),
  ]);

  const menuIds = [...new Set(itemsRes.rows.map((r) => r.menu_item_id).filter((id) => id !== null))];
  const menuRes = menuIds.length
    ? await runQuery(
        env,
        `SELECT id, name, price, special_price, special_starts_at, special_ends_at, is_visible, is_available, stock_quantity
           FROM menu_items WHERE id = ANY($1::int[]);`,
        [menuIds],
      )
    : { rows: [] };
  const menuById = Object.fromEntries(menuRes.rows.map((r) => [r.id, r]));

  const addonsRes = await runQuery(env, "SELECT name, price FROM addons WHERE is_active = TRUE;").catch(() => ({ rows: [] }));
  const addonPrice = Object.fromEntries(addonsRes.rows.map((a) => [a.name, parseFloat(a.price)]));

  const now = new Date();
  const itemsByOrder = {};
  for (const row of itemsRes.rows) (itemsByOrder[row.order_id] || (itemsByOrder[row.order_id] = [])).push(row);

  for (const order of ordersRes.rows) {
    const lines = itemsByOrder[order.id] || [];
    const problems = [];
    const wantedQty = {};
    for (const line of lines) {
      if (line.menu_item_id !== null) wantedQty[line.menu_item_id] = (wantedQty[line.menu_item_id] || 0) + Number(line.quantity);
    }

    let itemsChanged = false;
    const items = lines.map((line) => {
      const menu = line.menu_item_id !== null ? menuById[line.menu_item_id] : null;
      let itemPrice = parseFloat(line.item_price);

      if (!menu || !menu.is_visible) {
        problems.push(`"${line.item_name}" is no longer on the menu.`);
      } else {
        if (!menu.is_available) problems.push(`"${menu.name}" is sold out right now.`);
        else if (menu.stock_quantity !== null && wantedQty[menu.id] > menu.stock_quantity) {
          problems.push(`Only ${menu.stock_quantity} of "${menu.name}" left in stock.`);
        }
        itemPrice = specialIsActive(menu, now) ? parseFloat(menu.special_price) : parseFloat(menu.price);
      }

      // Extras follow today's add-on prices. Free sides, and extras that were renamed or removed, keep their saved price.
      const extras = (Array.isArray(line.extras) ? line.extras : []).map((extra) => {
        const isSide = String(extra.name || "").startsWith("Side:");
        const current = !isSide && addonPrice[extra.name] !== undefined ? addonPrice[extra.name] : parseFloat(extra.price);
        return { ...extra, price: current };
      });
      const extrasTotal = extras.reduce((sum, e) => sum + Number(e.price || 0), 0);
      const subtotal = round2((itemPrice + extrasTotal) * Number(line.quantity));

      if (round2(itemPrice) !== round2(line.item_price) || subtotal !== round2(line.subtotal)) itemsChanged = true;
      return { ...line, item_price: round2(itemPrice), extras, subtotal };
    });

    const total = round2(items.reduce((sum, i) => sum + i.subtotal, 0) + Number(order.delivery_fee || 0));
    const stored = round2(order.total_amount);
    result.set(order.id, { stored_total: stored, total, changed: itemsChanged || total !== stored, items, problems });
  }
  return result;
}

/** Saves today's prices on an order that is still unpaid (never touches paid orders). */
export async function saveRepricedOrder(env, orderId, priced) {
  const updated = await runQuery(
    env,
    "UPDATE orders SET total_amount = $1 WHERE id = $2 AND payment_status IN ('awaiting', 'failed') RETURNING id;",
    [priced.total, orderId],
  );
  if (!updated.rows.length) return false;
  for (const item of priced.items) {
    await runQuery(
      env,
      "UPDATE order_items SET item_price = $1, extras = $2::jsonb, subtotal = $3 WHERE id = $4;",
      [item.item_price, JSON.stringify(item.extras), item.subtotal, item.id],
    );
  }
  return true;
}
