// Walk-in (in-restaurant) orders: takeaway paid up front by card, and dine-in "tabs" paid at the end.
// Everything here is separate from the online checkout - online orders never go through this file.
//
//   Takeaway : order_source 'walk_in', order_type 'collection', payment_status 'paid' (card machine), goes straight to the kitchen.
//   Dine-in  : a tab (walkin_tabs) per table. Every time the guests order, that is a "round" = one orders row with
//              payment_status 'tab_open'. Each round goes to the kitchen at once. When the bill is closed, every
//              round becomes 'paid'. Only 'paid' orders count as revenue, so an unpaid tab never inflates the sales.

import { runQuery } from "./db.js";
import { takeOrderStock } from "./stock.js";
import { restoreOrderStock, ensureCancelledByColumn } from "./orderCancel.js";
import { logAudit } from "./audit.js";
import { sanitizeText, isValidName, VALIDATION_MESSAGES } from "./security.js";

export class WalkinError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// Same statements as db/migrations/020_walk_in.sql - so the app also works if the SQL hasn't been run yet.
// If the migration WAS run, this only does one cheap check. Concurrent callers share one run.
let schemaReady = false;
let schemaPromise = null;

async function runSchema(env) {
  const already = (
    await runQuery(
      env,
      `SELECT (SELECT COUNT(*) FROM information_schema.columns
                WHERE table_name = 'orders' AND column_name IN ('order_source', 'tab_id', 'captured_by')) AS cols,
              (SELECT to_regclass('walkin_tabs') IS NOT NULL) AS has_tabs;`,
    )
  ).rows[0];
  if (Number(already.cols) === 3 && already.has_tabs) return;

  // Two servers starting at the same moment can race on "IF NOT EXISTS" - one retry settles it.
  const run = async (sql) => {
    try {
      await runQuery(env, sql);
    } catch (err) {
      if (!/duplicate key|already exists/i.test(String(err.message))) throw err;
      await runQuery(env, sql);
    }
  };
  await run(
    `CREATE TABLE IF NOT EXISTS walkin_tabs (
       id SERIAL PRIMARY KEY,
       table_number TEXT NOT NULL,
       customer_name TEXT,
       status TEXT NOT NULL DEFAULT 'open',
       opened_by TEXT,
       opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       closed_at TIMESTAMPTZ,
       closed_by TEXT,
       payment_ref TEXT,
       write_off_reason TEXT
     );`,
  );
  await run("ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_source TEXT NOT NULL DEFAULT 'online';");
  await run("ALTER TABLE orders ADD COLUMN IF NOT EXISTS tab_id INTEGER REFERENCES walkin_tabs(id) ON DELETE SET NULL;");
  await run("ALTER TABLE orders ADD COLUMN IF NOT EXISTS captured_by TEXT;");
  await run("CREATE INDEX IF NOT EXISTS idx_orders_source_created ON orders (order_source, created_at DESC);");
  await run("CREATE INDEX IF NOT EXISTS idx_orders_tab ON orders (tab_id) WHERE tab_id IS NOT NULL;");
}

export function ensureWalkinSchema(env) {
  if (schemaReady) return Promise.resolve();
  if (!schemaPromise) {
    schemaPromise = runSchema(env)
      .then(() => {
        schemaReady = true;
      })
      .catch((err) => {
        schemaPromise = null; // try again on the next request
        throw err;
      });
  }
  return schemaPromise;
}

const actorName = (env) => env.__actorName || (env.__actorRole === "admin" ? "admin" : "staff");

/** Prices the cart from the database (never trusts prices sent by the browser). */
async function priceCart(env, cartItems) {
  if (!Array.isArray(cartItems) || cartItems.length === 0) throw new WalkinError("Add at least one item.");
  const itemIds = [...new Set(cartItems.map((i) => parseInt(i.id, 10)).filter(Number.isInteger))];
  const addonIds = [
    ...new Set(
      cartItems
        .flatMap((i) => (Array.isArray(i.extras) ? i.extras : []))
        .map((id) => parseInt(id, 10))
        .filter(Number.isInteger),
    ),
  ];
  if (itemIds.length === 0) throw new WalkinError("The order has no valid items.");

  const sideRows = await runQuery(
    env,
    `SELECT mis.menu_item_id, s.id, s.name
       FROM menu_item_sides mis JOIN sides s ON s.id = mis.side_id
      WHERE s.is_active = TRUE AND mis.menu_item_id = ANY($1::int[]);`,
    [itemIds],
  ).catch(() => ({ rows: [] }));
  const sidesByItem = {};
  for (const row of sideRows.rows) (sidesByItem[row.menu_item_id] || (sidesByItem[row.menu_item_id] = [])).push(row);

  const menuRows = await runQuery(
    env,
    `SELECT id, name, price, special_price, special_starts_at, special_ends_at, is_available, stock_quantity,
            is_visible, accepts_spice, accepts_addons
       FROM menu_items WHERE id = ANY($1::int[]);`,
    [itemIds],
  );
  const menuById = Object.fromEntries(menuRows.rows.map((r) => [r.id, r]));

  let addonsById = {};
  if (addonIds.length) {
    const addonRows = await runQuery(env, "SELECT id, name, price FROM addons WHERE id = ANY($1::int[]) AND is_active = TRUE;", [addonIds]);
    addonsById = Object.fromEntries(addonRows.rows.map((r) => [r.id, r]));
  }

  const lineItems = [];
  const qtyByItem = {};
  for (const cartItem of cartItems) {
    const menuItem = menuById[parseInt(cartItem.id, 10)];
    const quantity = parseInt(cartItem.quantity, 10);
    if (!menuItem || !menuItem.is_visible) throw new WalkinError(`Item ${cartItem.id} is no longer on the menu.`);
    if (!menuItem.is_available) throw new WalkinError(`"${menuItem.name}" is sold out right now.`);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 50) throw new WalkinError(`Invalid quantity for "${menuItem.name}".`);

    qtyByItem[menuItem.id] = (qtyByItem[menuItem.id] || 0) + quantity;
    if (menuItem.stock_quantity !== null && qtyByItem[menuItem.id] > menuItem.stock_quantity) {
      throw new WalkinError(`Only ${menuItem.stock_quantity} of "${menuItem.name}" left in stock.`);
    }

    const spiceLevel = menuItem.accepts_spice && cartItem.spice_level ? sanitizeText(String(cartItem.spice_level), 40) : null;
    const extras = [];
    if (menuItem.accepts_addons && Array.isArray(cartItem.extras)) {
      for (const raw of cartItem.extras) {
        const addon = addonsById[parseInt(raw, 10)];
        if (addon) extras.push({ name: addon.name, price: parseFloat(addon.price) });
      }
    }
    // A free side is required when the dish offers sides - stored as a R0 extra, like online orders.
    const offeredSides = sidesByItem[menuItem.id] || [];
    if (offeredSides.length > 0) {
      const chosen = offeredSides.find((sd) => sd.id === parseInt(cartItem.side, 10));
      if (!chosen) throw new WalkinError(`Please choose a side for "${menuItem.name}".`);
      extras.unshift({ name: `Side: ${chosen.name}`, price: 0 });
    }

    const now = new Date();
    const starts = menuItem.special_starts_at ? new Date(menuItem.special_starts_at) : null;
    const ends = menuItem.special_ends_at ? new Date(menuItem.special_ends_at) : null;
    const specialActive = menuItem.special_price !== null && (!starts || now >= starts) && (!ends || now < ends);
    const itemPrice = specialActive ? parseFloat(menuItem.special_price) : parseFloat(menuItem.price);
    const extrasTotal = extras.reduce((sum, e) => sum + e.price, 0);
    lineItems.push({
      menu_item_id: menuItem.id,
      item_name: menuItem.name,
      item_price: itemPrice,
      quantity,
      spice_level: spiceLevel,
      extras,
      subtotal: Math.round((itemPrice + extrasTotal) * quantity * 100) / 100,
    });
  }
  const itemsTotal = Math.round(lineItems.reduce((s, li) => s + li.subtotal, 0) * 100) / 100;
  return { lineItems, itemsTotal };
}

/**
 * Creates one walk-in order.
 *   type 'takeaway': paid by card first (cardPaid must be true), straight to the kitchen as a normal paid order.
 *   type 'dine_in' : a round on a tab - an existing tab (tabId) or a new one for tableNumber. Paid when the bill is closed.
 */
export async function createWalkinOrder(env, input) {
  await ensureWalkinSchema(env);
  const type = input.type === "dine_in" ? "dine_in" : input.type === "takeaway" ? "takeaway" : "";
  if (!type) throw new WalkinError("Choose takeaway or dine-in.");

  const guestName = sanitizeText(input.customer_name || "", 100);
  if (guestName && !isValidName(guestName)) throw new WalkinError(VALIDATION_MESSAGES.name);
  const instructions = sanitizeText(input.special_instructions || "", 500);
  const cardRef = sanitizeText(input.card_reference || "", 100);

  if (type === "takeaway" && input.card_paid !== true) {
    throw new WalkinError("Take the card payment first, then confirm it was paid.");
  }

  const { lineItems, itemsTotal } = await priceCart(env, input.items);

  // Which tab (dine-in only)
  let tab = null;
  let createdTab = false;
  if (type === "dine_in") {
    const tabId = parseInt(input.tab_id, 10);
    if (Number.isInteger(tabId)) {
      tab = (await runQuery(env, "SELECT id, table_number, customer_name FROM walkin_tabs WHERE id = $1 AND status = 'open';", [tabId])).rows[0];
      if (!tab) throw new WalkinError("That tab is no longer open. Refresh and try again.", 409);
    } else {
      const table = sanitizeText(input.table_number || "", 30);
      if (!table) throw new WalkinError("Enter the table number.");
      const dup = (await runQuery(env, "SELECT id FROM walkin_tabs WHERE status = 'open' AND LOWER(table_number) = LOWER($1);", [table])).rows[0];
      if (dup) {
        throw new WalkinError(`Table ${table} already has an open tab - add this order to it.`, 409, { existing_tab_id: dup.id });
      }
      tab = (
        await runQuery(
          env,
          "INSERT INTO walkin_tabs (table_number, customer_name, opened_by) VALUES ($1, $2, $3) RETURNING id, table_number, customer_name;",
          [table, guestName || null, actorName(env)],
        )
      ).rows[0];
      createdTab = true;
    }
  }

  const isTakeaway = type === "takeaway";
  const orderRes = await runQuery(
    env,
    `INSERT INTO orders
       (customer_id, customer_name, customer_phone, order_type, table_number, pickup_time, special_instructions,
        total_amount, status, payment_method, payment_status, payment_ref, payment_confirmed_at, kitchen_release_at,
        stock_decremented, order_source, tab_id, captured_by)
     VALUES (NULL, $1, '', $2, $3, 'As soon as possible', $4, $5, 'New', 'card_machine', $6, $7, $8, NOW(), FALSE, 'walk_in', $9, $10)
     RETURNING id, created_at;`,
    [
      guestName || (tab && tab.customer_name) || "Walk-in",
      isTakeaway ? "collection" : "dine_in",
      isTakeaway ? null : tab.table_number,
      instructions || null,
      itemsTotal,
      isTakeaway ? "paid" : "tab_open",
      isTakeaway ? cardRef || null : null,
      isTakeaway ? new Date().toISOString() : null,
      tab ? tab.id : null,
      actorName(env),
    ],
  );
  const orderId = orderRes.rows[0].id;

  const undo = async () => {
    await runQuery(env, "DELETE FROM orders WHERE id = $1;", [orderId]).catch(() => {});
    if (createdTab) await runQuery(env, "DELETE FROM walkin_tabs WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM orders WHERE tab_id = walkin_tabs.id);", [tab.id]).catch(() => {});
  };

  try {
    for (const li of lineItems) {
      await runQuery(
        env,
        `INSERT INTO order_items (order_id, menu_item_id, item_name, item_price, quantity, spice_level, extras, subtotal)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8);`,
        [orderId, li.menu_item_id, li.item_name, li.item_price, li.quantity, li.spice_level, JSON.stringify(li.extras), li.subtotal],
      );
    }
    // Stock is taken now (the guests are in the building and the food is being made).
    const stock = await takeOrderStock(env, orderId);
    if (!stock.ok) {
      await undo();
      throw new WalkinError(`Sold out: ${(stock.sold_out || []).join(", ") || "an item in the order"}.`, 409);
    }
  } catch (err) {
    if (!(err instanceof WalkinError)) await undo();
    throw err;
  }

  await logAudit(env, {
    action: isTakeaway ? "walkin_takeaway_paid_by_card" : "walkin_tab_round_added",
    target_type: "order",
    target_id: orderId,
    details: {
      total_amount: itemsTotal,
      order_type: isTakeaway ? "takeaway" : "dine_in",
      tab_id: tab ? tab.id : undefined,
      table: tab ? tab.table_number : undefined,
      new_tab: createdTab || undefined,
      card_reference: cardRef || undefined,
    },
  });

  return { order_id: orderId, tab_id: tab ? tab.id : null, total_amount: itemsTotal, new_tab: createdTab };
}

/** Open tabs with every round and its items (what the "Open tabs" screen and the bill show). */
export async function listOpenTabs(env) {
  await ensureWalkinSchema(env);
  const tabs = (
    await runQuery(env, "SELECT id, table_number, customer_name, opened_by, opened_at FROM walkin_tabs WHERE status = 'open' ORDER BY opened_at ASC;")
  ).rows;
  if (!tabs.length) return [];
  const ids = tabs.map((t) => t.id);
  const rounds = (
    await runQuery(
      env,
      `SELECT id, tab_id, status, total_amount, special_instructions, created_at, captured_by
         FROM orders WHERE tab_id = ANY($1::int[]) ORDER BY id ASC;`,
      [ids],
    )
  ).rows;
  const items = rounds.length
    ? (
        await runQuery(
          env,
          `SELECT id, order_id, item_name, item_price, quantity, spice_level, extras, subtotal
             FROM order_items WHERE order_id = ANY($1::int[]) ORDER BY id ASC;`,
          [rounds.map((r) => r.id)],
        )
      ).rows
    : [];
  const itemsByOrder = {};
  for (const it of items) (itemsByOrder[it.order_id] || (itemsByOrder[it.order_id] = [])).push({ ...it, subtotal: Number(it.subtotal), item_price: Number(it.item_price) });

  return tabs.map((tab) => {
    const mine = rounds.filter((r) => r.tab_id === tab.id).map((r, i) => ({
      ...r,
      round: i + 1,
      total_amount: Number(r.total_amount),
      items: itemsByOrder[r.id] || [],
    }));
    const total = mine.filter((r) => r.status !== "Cancelled").reduce((s, r) => s + r.total_amount, 0);
    return { ...tab, rounds: mine, total: Math.round(total * 100) / 100 };
  });
}

/** Closes the bill: the guests paid by card. Every round that wasn't cancelled becomes paid. */
export async function closeTab(env, { tabId, cardReference }) {
  await ensureWalkinSchema(env);
  const id = parseInt(tabId, 10);
  if (!Number.isInteger(id)) throw new WalkinError("A valid tab is required.");
  const ref = sanitizeText(cardReference || "", 100) || null;

  const closed = (
    await runQuery(
      env,
      `UPDATE walkin_tabs SET status = 'closed', closed_at = NOW(), closed_by = $2, payment_ref = $3
        WHERE id = $1 AND status = 'open' RETURNING id, table_number;`,
      [id, actorName(env), ref],
    )
  ).rows[0];
  if (!closed) throw new WalkinError("This tab was already closed. Refresh and check.", 409);

  const paid = (
    await runQuery(
      env,
      `UPDATE orders
          SET payment_status = 'paid', payment_method = 'card_machine', payment_ref = $2, payment_confirmed_at = NOW()
        WHERE tab_id = $1 AND status <> 'Cancelled' AND payment_status = 'tab_open'
        RETURNING id, total_amount;`,
      [id, ref],
    )
  ).rows;
  await runQuery(env, "UPDATE orders SET payment_status = 'void' WHERE tab_id = $1 AND status = 'Cancelled' AND payment_status = 'tab_open';", [id]);

  const total = Math.round(paid.reduce((s, r) => s + Number(r.total_amount), 0) * 100) / 100;
  await logAudit(env, {
    action: "walkin_tab_closed_paid_by_card",
    target_type: "order",
    target_id: paid[0] ? paid[0].id : null,
    details: { tab_id: id, table: closed.table_number, total_amount: total, rounds: paid.length, card_reference: ref || undefined },
  });
  return { tab_id: id, total_amount: total, rounds: paid.length };
}

/** Takes one item off a round of an open tab. Staff: only before the kitchen starts it. Admin: any time. */
export async function removeTabItem(env, { orderId, itemId }) {
  await ensureWalkinSchema(env);
  const oid = parseInt(orderId, 10);
  const iid = parseInt(itemId, 10);
  if (!Number.isInteger(oid) || !Number.isInteger(iid)) throw new WalkinError("A valid item is required.");
  const isAdmin = env.__actorRole === "admin";

  const order = (
    await runQuery(
      env,
      `SELECT o.id, o.status, o.stock_decremented, o.tab_id
         FROM orders o JOIN walkin_tabs t ON t.id = o.tab_id
        WHERE o.id = $1 AND o.order_source = 'walk_in' AND o.payment_status = 'tab_open' AND t.status = 'open';`,
      [oid],
    )
  ).rows[0];
  if (!order) throw new WalkinError("That order isn't on an open tab any more.", 409);
  if (["Cancelled"].includes(order.status)) throw new WalkinError("That order was already cancelled.", 409);
  if (!isAdmin && order.status !== "New") {
    throw new WalkinError("The kitchen has already started this order. Ask the admin to take the item off the bill.", 403);
  }

  const item = (await runQuery(env, "SELECT id, menu_item_id, item_name, quantity, subtotal FROM order_items WHERE id = $1 AND order_id = $2;", [iid, oid])).rows[0];
  if (!item) throw new WalkinError("That item was already removed.", 409);

  // Not started yet -> the dish goes back on the shelf. Already made -> the stock stays used.
  if (order.status === "New" && order.stock_decremented && item.menu_item_id) {
    await runQuery(
      env,
      `UPDATE menu_items SET stock_quantity = stock_quantity + $1, is_available = TRUE
        WHERE id = $2 AND stock_quantity IS NOT NULL;`,
      [item.quantity, item.menu_item_id],
    );
  }
  await runQuery(env, "DELETE FROM order_items WHERE id = $1;", [iid]);
  const left = (await runQuery(env, "SELECT COALESCE(SUM(subtotal), 0) AS total, COUNT(*)::int AS n FROM order_items WHERE order_id = $1;", [oid])).rows[0];

  let cancelledOrder = false;
  if (left.n === 0) {
    await ensureCancelledByColumn(env);
    await runQuery(
      env,
      `UPDATE orders SET status = 'Cancelled', total_amount = 0, stock_decremented = FALSE,
                         cancelled_by = $2, cancel_reason = 'All items removed from the bill'
        WHERE id = $1;`,
      [oid, isAdmin ? "admin" : "staff"],
    );
    cancelledOrder = true;
  } else {
    await runQuery(env, "UPDATE orders SET total_amount = $2 WHERE id = $1;", [oid, left.total]);
  }

  await logAudit(env, {
    action: "walkin_tab_item_removed",
    target_type: "order",
    target_id: oid,
    details: {
      tab_id: order.tab_id,
      item: item.item_name,
      quantity: item.quantity,
      amount: Number(item.subtotal),
      status_when_removed: order.status,
      round_cancelled: cancelledOrder || undefined,
    },
  });
  return { order_id: oid, new_total: Number(left.total), round_cancelled: cancelledOrder };
}

/** Admin only: the guests left without paying. Takes the tab off the books (it never counts as revenue). */
export async function writeOffTab(env, { tabId, reason }) {
  await ensureWalkinSchema(env);
  if (env.__actorRole !== "admin") throw new WalkinError("Only an admin can write off a tab.", 403);
  const id = parseInt(tabId, 10);
  if (!Number.isInteger(id)) throw new WalkinError("A valid tab is required.");
  const why = sanitizeText(reason || "", 300);
  if (!why) throw new WalkinError("Give a reason for writing off this tab.");

  const tab = (
    await runQuery(
      env,
      `UPDATE walkin_tabs SET status = 'written_off', closed_at = NOW(), closed_by = $2, write_off_reason = $3
        WHERE id = $1 AND status = 'open' RETURNING id, table_number;`,
      [id, actorName(env), why],
    )
  ).rows[0];
  if (!tab) throw new WalkinError("This tab was already closed. Refresh and check.", 409);

  await ensureCancelledByColumn(env);
  const rounds = (await runQuery(env, "SELECT id, status, total_amount FROM orders WHERE tab_id = $1 AND status <> 'Cancelled';", [id])).rows;
  let lost = 0;
  for (const r of rounds) {
    if (r.status !== "New") lost += Number(r.total_amount); // food that was made but not paid for
    if (r.status === "New") {
      // Never started: cancel it and put the stock back.
      await runQuery(env, "UPDATE orders SET status = 'Cancelled', cancelled_by = 'admin', cancel_reason = $2, payment_status = 'written_off' WHERE id = $1;", [r.id, `Tab written off: ${why}`]);
      await restoreOrderStock(env, r.id);
    } else {
      // Already being made or served: it is finished, but nobody paid for it.
      await runQuery(env, "UPDATE orders SET status = CASE WHEN status IN ('Completed') THEN status ELSE 'Completed' END, payment_status = 'written_off' WHERE id = $1;", [r.id]);
    }
  }
  await runQuery(env, "UPDATE orders SET payment_status = 'void' WHERE tab_id = $1 AND status = 'Cancelled' AND payment_status = 'tab_open';", [id]);

  await logAudit(env, {
    action: "walkin_tab_written_off",
    target_type: "order",
    target_id: rounds[0] ? rounds[0].id : null,
    details: { tab_id: id, table: tab.table_number, unpaid_amount: Math.round(lost * 100) / 100, reason: why },
  });
  return { tab_id: id, unpaid_amount: Math.round(lost * 100) / 100 };
}
