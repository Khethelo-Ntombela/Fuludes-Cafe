// A signed-in customer's cart, kept on their account
import { runQuery } from "./db.js";

export const MAX_CART_LINES = 60;
export const MAX_LINE_QUANTITY = 50;
const CART_TTL_DAYS = 30;

let tableReady = false;
export async function ensureCartTable(env, query = runQuery) {
  if (tableReady) return;
  await query(
    env,
    `CREATE TABLE IF NOT EXISTS customer_carts (
       customer_id  INTEGER PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
       items        JSONB NOT NULL DEFAULT '[]'::jsonb,
       version      INTEGER NOT NULL DEFAULT 1,
       updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
     );`,
  );
  tableReady = true;
}

// Compact lines

/** Same key the menu page uses for a cart line (public/js/menu.js addToCart). */
export function lineKey(c) {
  const extras = (c.extraIds || []).map(String).sort().join(",");
  return `${c.itemId}|${c.spiceLevel || ""}|${c.sideId || ""}|${extras}`;
}

function toPositiveInt(value) {
  const n = typeof value === "number" ? value : parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Cleans untrusted input into compact lines: { itemId, quantity, spiceLevel|null, sideId|null
export function normalizeCompact(raw) {
  if (!Array.isArray(raw)) return [];
  const byKey = new Map();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const itemId = toPositiveInt(entry.itemId);
    const quantity = toPositiveInt(entry.quantity);
    if (!itemId || !quantity) continue;
    const spice =
      typeof entry.spiceLevel === "string" && entry.spiceLevel.trim()
        ? entry.spiceLevel.trim().slice(0, 50)
        : null;
    const extraIds = [
      ...new Set((Array.isArray(entry.extraIds) ? entry.extraIds : []).map(toPositiveInt).filter(Boolean)),
    ].sort((a, b) => a - b);
    const line = {
      itemId,
      quantity: Math.min(quantity, MAX_LINE_QUANTITY),
      spiceLevel: spice,
      sideId: toPositiveInt(entry.sideId),
      extraIds,
    };
    const key = lineKey(line);
    const existing = byKey.get(key);
    if (existing) existing.quantity = Math.min(existing.quantity + line.quantity, MAX_LINE_QUANTITY);
    else if (byKey.size < MAX_CART_LINES) byKey.set(key, line);
  }
  return [...byKey.values()];
}

/** Merging two carts adds up identical lines instead of one overwriting the other. */
export function mergeCompact(a, b) {
  return normalizeCompact([...(a || []), ...(b || [])]);
}

/** Back from full lines (as the menu page holds them) to compact lines. */
export function compactFromLines(lines) {
  return normalizeCompact(
    (lines || []).map((l) => ({
      itemId: l.itemId,
      quantity: l.quantity,
      spiceLevel: l.spiceLevel,
      sideId: l.side ? l.side.id : null,
      extraIds: (l.extras || []).map((e) => e.id),
    })),
  );
}

// Rebuild full lines from the live menu

// Turns compact lines into the full lines the menu page shows ({ lineId, itemId, name, price
export async function hydrateCart(env, compact, query = runQuery) {
  const items = normalizeCompact(compact);
  if (!items.length) return { lines: [], notices: [] };

  const itemIds = [...new Set(items.map((c) => c.itemId))];
  const [menuRes, sideRes, addonRes, spiceRes] = await Promise.all([
    query(
      env,
      `SELECT id, name, price, special_price, special_starts_at, special_ends_at,
              is_available, stock_quantity, is_visible, accepts_spice, accepts_addons
         FROM menu_items WHERE id = ANY($1::int[]);`,
      [itemIds],
    ),
    query(
      env,
      `SELECT mis.menu_item_id, s.id, s.name
         FROM menu_item_sides mis JOIN sides s ON s.id = mis.side_id
        WHERE s.is_active = TRUE AND mis.menu_item_id = ANY($1::int[]);`,
      [itemIds],
    ).catch(() => ({ rows: [] })), // sides table not created yet (migration 006)
    query(
      env,
      `SELECT mia.menu_item_id, a.id, a.name, a.price
         FROM menu_item_addons mia JOIN addons a ON a.id = mia.addon_id
        WHERE a.is_active = TRUE AND mia.menu_item_id = ANY($1::int[]);`,
      [itemIds],
    ),
    query(env, "SELECT name FROM spice_levels;"),
  ]);

  const menuById = new Map(menuRes.rows.map((r) => [Number(r.id), r]));
  const sidesByItem = new Map();
  for (const r of sideRes.rows) {
    const list = sidesByItem.get(Number(r.menu_item_id)) || [];
    list.push({ id: Number(r.id), name: r.name });
    sidesByItem.set(Number(r.menu_item_id), list);
  }
  const addonsByItem = new Map();
  for (const r of addonRes.rows) {
    const list = addonsByItem.get(Number(r.menu_item_id)) || [];
    list.push({ id: Number(r.id), name: r.name, price: parseFloat(r.price) });
    addonsByItem.set(Number(r.menu_item_id), list);
  }
  const spiceNames = new Set(spiceRes.rows.map((r) => r.name));

  const now = new Date();
  const notices = [];
  const note = (message) => {
    if (!notices.includes(message)) notices.push(message);
  };
  const stockLeft = new Map(); // item id -> how many can still go into the cart
  const lines = [];

  for (const c of items) {
    const item = menuById.get(c.itemId);
    if (!item || !item.is_visible) {
      note("An item in your cart is no longer on the menu and was removed.");
      continue;
    }
    const tracked = item.stock_quantity !== null && item.stock_quantity !== undefined;
    if (!item.is_available || (tracked && item.stock_quantity <= 0)) {
      note(`"${item.name}" is sold out and was removed from your cart.`);
      continue;
    }

    // Free side: a dish that offers sides needs one of the sides it offers today.
    const offeredSides = sidesByItem.get(item.id) || [];
    let side = null;
    if (offeredSides.length) {
      side = offeredSides.find((s) => s.id === c.sideId) || null;
      if (!side) {
        note(`"${item.name}" was removed because its side options changed. Please add it again.`);
        continue;
      }
    }

    // Paid extras: keep those still offered for this dish.
    const offeredExtras = item.accepts_addons ? addonsByItem.get(item.id) || [] : [];
    const extras = c.extraIds.map((id) => offeredExtras.find((e) => e.id === id)).filter(Boolean);
    if (extras.length < c.extraIds.length) note(`Some extras for "${item.name}" are no longer available and were removed.`);

    const spiceLevel = item.accepts_spice && c.spiceLevel && spiceNames.has(c.spiceLevel) ? c.spiceLevel : null;

    // Quantity: never more than what's left, counted across every line of the same dish.
    let quantity = c.quantity;
    if (tracked) {
      const left = stockLeft.has(item.id) ? stockLeft.get(item.id) : item.stock_quantity;
      if (left <= 0) {
        note(`"${item.name}" is sold out and was removed from your cart.`);
        continue;
      }
      if (quantity > left) {
        quantity = left;
        note(`Only ${left} of "${item.name}" left, so we lowered the quantity.`);
      }
      stockLeft.set(item.id, left - quantity);
    }

    // Price right now: the special price only while the special is running.
    const price = parseFloat(item.price);
    const special = item.special_price !== null && item.special_price !== undefined ? parseFloat(item.special_price) : null;
    const starts = item.special_starts_at ? new Date(item.special_starts_at) : null;
    const ends = item.special_ends_at ? new Date(item.special_ends_at) : null;
    const onSpecial = special !== null && (!starts || now >= starts) && (!ends || now < ends);

    const line = {
      itemId: item.id,
      name: item.name,
      price: onSpecial ? special : price,
      quantity,
      spiceLevel,
      side,
      extras,
    };
    line.lineId = lineKey({
      itemId: line.itemId,
      spiceLevel,
      sideId: side ? side.id : null,
      extraIds: extras.map((e) => e.id),
    });
    lines.push(line);
  }
  return { lines, notices };
}

// Storage

/** { items: compact[], version } - version 0 means "no saved cart". */
export async function loadSavedCart(env, customerId, query = runQuery) {
  await ensureCartTable(env, query);
  const res = await query(
    env,
    `SELECT items, version FROM customer_carts
      WHERE customer_id = $1 AND updated_at > NOW() - INTERVAL '${CART_TTL_DAYS} days';`,
    [customerId],
  );
  const row = res.rows[0];
  if (!row) return { items: [], version: 0 };
  const stored = typeof row.items === "string" ? JSON.parse(row.items) : row.items;
  return { items: normalizeCompact(stored), version: Number(row.version) };
}

/** Replaces the saved cart. Returns the new version. */
export async function writeSavedCart(env, customerId, compact, query = runQuery) {
  await ensureCartTable(env, query);
  const res = await query(
    env,
    `INSERT INTO customer_carts (customer_id, items, version, updated_at)
          VALUES ($1, $2::jsonb, 1, NOW())
     ON CONFLICT (customer_id) DO UPDATE
             SET items = EXCLUDED.items,
                 version = customer_carts.version + 1,
                 updated_at = NOW()
       RETURNING version;`,
    [customerId, JSON.stringify(normalizeCompact(compact))],
  );
  return Number(res.rows[0].version);
}

// Saves the cleaned-up cart only if nobody changed it since it was read (compare-and-set on version)
export async function tidySavedCart(env, customerId, compact, readVersion, query = runQuery) {
  if (!readVersion) return readVersion;
  const res = await query(
    env,
    `UPDATE customer_carts
        SET items = $2::jsonb, version = version + 1, updated_at = NOW()
      WHERE customer_id = $1 AND version = $3
      RETURNING version;`,
    [customerId, JSON.stringify(normalizeCompact(compact)), readVersion],
  );
  return res.rows[0] ? Number(res.rows[0].version) : readVersion;
}

/** Removes the saved cart (called when an order is placed). Never throws. */
export async function clearSavedCart(env, customerId, query = runQuery) {
  try {
    await ensureCartTable(env, query);
    await query(env, "DELETE FROM customer_carts WHERE customer_id = $1;", [customerId]);
  } catch {
    /* a cart that can't be cleared must never fail an order that was placed */
  }
}
