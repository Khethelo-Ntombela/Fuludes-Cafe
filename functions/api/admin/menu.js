/**
 * functions/api/admin/menu.js
 * -----------------------------------------------------------------------
 * Full CRUD for menu items, used by public/js/admin.js to let Fulufhelo
 * add, categorize, and manage dishes from her phone.
 *
 * GET    /api/admin/menu          -> every item (incl. hidden/sold out),
 *                                    each with its assigned addon ids
 * POST   /api/admin/menu          -> create an item
 * PUT    /api/admin/menu          -> update an item (body must include id)
 * DELETE /api/admin/menu?id=5     -> delete an item
 *
 * Body shape for POST/PUT:
 * {
 *   category_id, name, description, price,
 *   images: ["https://.../a.webp", "https://.../b.webp"],  // up to MAX_IMAGES,
 *                                                            // first = cover photo
 *   stock_quantity, special_price, is_visible, accepts_spice, accepts_addons,
 *   addon_ids: [1, 2]   // which global addons this dish accepts
 * }
 *
 * is_available is no longer accepted directly from the client - it's a
 * "Sold Out" badge derived server-side from stock_quantity: blank/null
 * means untracked (always available), a number means available while
 * that number is above 0. Ordering (functions/api/order.js) decrements
 * stock_quantity automatically; this file is where the admin sets or
 * restocks the number.
 *
 * special_price is nullable - blank/null means the item isn't on special.
 * When set it must be less than `price` and becomes the item's actual
 * selling price everywhere (customer menu, cart, checkout) until an admin
 * clears it again from the Specials tab.
 * -----------------------------------------------------------------------
 */
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { requireAdmin } from "../../_lib/auth.js";
import { logAudit, diffChanges, summarizeChanges, money } from "../../_lib/audit.js";
import { getRequestIp } from "../../_lib/security.js";

const yesNo = (v) => (v ? "Yes" : "No");
const dateText = (v) => (v ? new Date(v).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "none");

// Fields that count as a normal menu edit vs. a "special" edit, so the audit
// log can show them as two clearly separate events.
const MENU_FIELDS = {
  name: { label: "Name" },
  category_id: { label: "Category" },
  description: { label: "Description" },
  price: { label: "Price", format: money },
  stock_quantity: { label: "Stock", format: (v) => (v === null || v === undefined ? "unlimited" : String(v)) },
  is_visible: { label: "Visible on menu", format: yesNo },
  accepts_spice: { label: "Spice option", format: yesNo },
  accepts_addons: { label: "Extras option", format: yesNo },
  image_url: { label: "Cover photo", format: (v) => (v ? "set" : "none") },
};
const SPECIAL_FIELDS = {
  special_price: { label: "Special price", format: money },
  special_starts_at: { label: "Special starts", format: dateText },
  special_ends_at: { label: "Special ends", format: dateText },
};

async function auditMenu(context, action, item, summary, changes = []) {
  try {
    await logAudit(context.env, {
      actor_type: "admin",
      actor_role: "admin",
      actor_ip: getRequestIp(context.request),
      action,
      target_type: "menu_item",
      target_id: item?.id ?? null,
      details: { item: item?.name || null, summary, changes },
    });
  } catch (e) {
    console.error("audit log failed", e);
  }
}

const MAX_IMAGES = 6; // keeps R2 usage + gallery UI sane for a small cafe menu

/**
 * Normalizes the incoming stock_quantity field. Blank/null/undefined means
 * "not tracked - always available" (NULL in the DB). Otherwise it must be a
 * whole number >= 0.
 */
function parseStockQuantity(raw) {
  if (raw === null || raw === undefined || raw === "")
    return { ok: true, value: null };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return { ok: false, value: null };
  return { ok: true, value: n };
}

/**
 * Normalizes the incoming special_price field against the item's regular
 * price. Blank/null/undefined means "not on special" (NULL in the DB).
 * Otherwise it must be a non-negative number strictly less than `price` -
 * a "special" that isn't actually a discount would just be confusing.
 */
function parseSpecialPrice(raw, price) {
  if (raw === null || raw === undefined || raw === "")
    return { ok: true, value: null };
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n >= price)
    return { ok: false, value: null };
  return { ok: true, value: n };
}

function parseSpecialDate(raw) {
  if (raw === null || raw === undefined || raw === "")
    return { ok: true, value: null };
  const d = new Date(raw);
  if (!isFinite(d.getTime())) return { ok: false, value: null };
  return { ok: true, value: d.toISOString() };
}

async function syncAddonLinks(env, menuItemId, addonIds) {
  await runQuery(env, "DELETE FROM menu_item_addons WHERE menu_item_id = $1;", [
    menuItemId,
  ]);
  const ids = Array.isArray(addonIds)
    ? [
        ...new Set(
          addonIds.map((id) => parseInt(id, 10)).filter(Number.isInteger),
        ),
      ]
    : [];
  for (const addonId of ids) {
    await runQuery(
      env,
      "INSERT INTO menu_item_addons (menu_item_id, addon_id) VALUES ($1, $2) ON CONFLICT DO NOTHING;",
      [menuItemId, addonId],
    );
  }
  return ids;
}

async function syncSideLinks(env, menuItemId, sideIds) {
  // Only touch links when the client actually sent side_ids (older admin pages don't).
  if (!Array.isArray(sideIds)) return undefined;
  await runQuery(env, "DELETE FROM menu_item_sides WHERE menu_item_id = $1;", [menuItemId]);
  const ids = [...new Set(sideIds.map((id) => parseInt(id, 10)).filter(Number.isInteger))];
  for (const sideId of ids) {
    await runQuery(
      env,
      "INSERT INTO menu_item_sides (menu_item_id, side_id) VALUES ($1, $2) ON CONFLICT DO NOTHING;",
      [menuItemId, sideId],
    );
  }
  return ids;
}

async function syncIngredients(env, menuItemId, ingredients) {
  // ingredients is an array of strings (ingredient names)
  const names = Array.isArray(ingredients)
    ? [...new Set(ingredients.map((s) => s.trim()).filter((s) => s.length > 0))]
    : [];
  await runQuery(env, "DELETE FROM dish_ingredients WHERE menu_item_id = $1;", [
    menuItemId,
  ]);
  for (const name of names) {
    await runQuery(
      env,
      "INSERT INTO dish_ingredients (menu_item_id, ingredient_name) VALUES ($1, $2) ON CONFLICT DO NOTHING;",
      [menuItemId, name],
    );
  }
  return names;
}

/**
 * Replaces a dish's photo gallery and keeps menu_items.image_url (the
 * denormalized cover photo used by the customer grid) in sync with
 * whichever URL is first in the list.
 */
async function syncImages(env, menuItemId, imageUrls) {
  const urls = (Array.isArray(imageUrls) ? imageUrls : [])
    .filter((url) => typeof url === "string" && url.trim().length > 0)
    .slice(0, MAX_IMAGES);

  await runQuery(env, "DELETE FROM menu_item_images WHERE menu_item_id = $1;", [
    menuItemId,
  ]);
  for (let i = 0; i < urls.length; i++) {
    await runQuery(
      env,
      "INSERT INTO menu_item_images (menu_item_id, image_url, sort_order) VALUES ($1, $2, $3);",
      [menuItemId, urls[i], i],
    );
  }
  await runQuery(env, "UPDATE menu_items SET image_url = $1 WHERE id = $2;", [
    urls[0] || null,
    menuItemId,
  ]);
  return urls;
}

const DRINK_TYPES = ["beverage", "cocktail", "alcohol", "other"];
let drinkTypeColumnReady = false;

/** menu_items.drink_type (migration 008) - added here too so the admin works before the migration is run. */
async function ensureDrinkTypeColumn(env) {
  if (drinkTypeColumnReady) return;
  await runQuery(env, "ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS drink_type TEXT;");
  drinkTypeColumnReady = true;
}

/** Stores the drink sub-type; anything unrecognised becomes NULL (food). */
async function syncDrinkType(env, menuItemId, raw) {
  await ensureDrinkTypeColumn(env);
  const drinkType = DRINK_TYPES.includes(raw) ? raw : null;
  await runQuery(env, "UPDATE menu_items SET drink_type = $1 WHERE id = $2;", [drinkType, menuItemId]);
  return drinkType;
}

export async function onRequestGet(context) {
  const authError = await requireAdmin(context.request, context.env);
  if (authError) return authError;
  await ensureDrinkTypeColumn(context.env);

  const [itemsResult, linksResult, imagesResult, ingredientsResult, sideLinksResult] = await Promise.all([
    runQuery(
      context.env,
      `
      SELECT m.id, m.category_id, c.name AS category_name, m.name, m.description, m.price, m.special_price,
             m.special_starts_at, m.special_ends_at, m.image_url, m.is_available, m.stock_quantity, m.is_visible, m.accepts_spice, m.accepts_addons, m.sort_order, m.drink_type
      FROM menu_items m
      JOIN categories c ON c.id = m.category_id
      ORDER BY c.sort_order ASC, m.sort_order ASC, m.name ASC;
    `,
    ),
    runQuery(
      context.env,
      "SELECT menu_item_id, addon_id FROM menu_item_addons;",
    ),
    runQuery(
      context.env,
      "SELECT menu_item_id, image_url FROM menu_item_images ORDER BY sort_order ASC, id ASC;",
    ),
    runQuery(
      context.env,
      "SELECT menu_item_id, ingredient_name FROM dish_ingredients ORDER BY ingredient_name ASC;",
    ),
    runQuery(
      context.env,
      "SELECT menu_item_id, side_id FROM menu_item_sides;",
    ).catch(() => ({ rows: [] })), // sides table not created yet (migration 006)
  ]);

  const sideIdsByItem = {};
  for (const row of sideLinksResult.rows) {
    (sideIdsByItem[row.menu_item_id] || (sideIdsByItem[row.menu_item_id] = [])).push(row.side_id);
  }

  const addonIdsByItem = {};
  for (const row of linksResult.rows) {
    (
      addonIdsByItem[row.menu_item_id] ||
      (addonIdsByItem[row.menu_item_id] = [])
    ).push(row.addon_id);
  }

  const imagesByItem = {};
  for (const row of imagesResult.rows) {
    (
      imagesByItem[row.menu_item_id] || (imagesByItem[row.menu_item_id] = [])
    ).push(row.image_url);
  }

  const ingredientsByItem = {};
  for (const row of ingredientsResult.rows) {
    (
      ingredientsByItem[row.menu_item_id] || (ingredientsByItem[row.menu_item_id] = [])
    ).push(row.ingredient_name);
  }

  const items = itemsResult.rows.map((item) => ({
    ...item,
    price: parseFloat(item.price),
    special_price:
      item.special_price !== null ? parseFloat(item.special_price) : null,
    special_starts_at: item.special_starts_at
      ? new Date(item.special_starts_at).toISOString()
      : null,
    special_ends_at: item.special_ends_at
      ? new Date(item.special_ends_at).toISOString()
      : null,
    addon_ids: addonIdsByItem[item.id] || [],
    side_ids: sideIdsByItem[item.id] || [],
    ingredients: ingredientsByItem[item.id] || [],
    images: imagesByItem[item.id] || (item.image_url ? [item.image_url] : []),
  }));

  return jsonResponse({ items });
}

export async function onRequestPost(context) {
  const authError = await requireAdmin(context.request, context.env);
  if (authError) return authError;

  try {
    const body = await context.request.json();
    const name = (body.name || "").trim();
    const categoryId = parseInt(body.category_id, 10);
    const price = parseFloat(body.price);

    if (
      !name ||
      !Number.isInteger(categoryId) ||
      !Number.isFinite(price) ||
      price < 0
    ) {
      return jsonResponse(
        { error: "Name, category, and a valid price are required." },
        400,
      );
    }
    if (name.length > 100) return jsonResponse({ error: "Item names can be at most 100 characters." }, 400);
    if (price > 100000) return jsonResponse({ error: "That price looks too high - please check it." }, 400);

    const stockResult = parseStockQuantity(body.stock_quantity);
    if (!stockResult.ok) {
      return jsonResponse(
        {
          error:
            "Stock quantity must be left blank (unlimited) or a whole number of 0 or more.",
        },
        400,
      );
    }
    const stockQuantity = stockResult.value;
    const isAvailable = stockQuantity === null ? true : stockQuantity > 0;

    const specialResult = parseSpecialPrice(body.special_price, price);
    if (!specialResult.ok) {
      return jsonResponse(
        {
          error:
            "Special price must be left blank, or a valid amount that's less than the regular price.",
        },
        400,
      );
    }
    const specialPrice = specialResult.value;

    const startsResult = parseSpecialDate(body.special_starts_at);
    if (!startsResult.ok)
      return jsonResponse({ error: "Invalid special start datetime." }, 400);
    const endsResult = parseSpecialDate(body.special_ends_at);
    if (!endsResult.ok)
      return jsonResponse({ error: "Invalid special end datetime." }, 400);
    const specialStarts = startsResult.value;
    const specialEnds = endsResult.value;
    if (
      specialStarts &&
      specialEnds &&
      new Date(specialEnds) <= new Date(specialStarts)
    ) {
      return jsonResponse(
        { error: "Special end must be after its start." },
        400,
      );
    }

    // Accept either the new `images` array or the legacy single `image_url`
    // (kept for backward compatibility with any older client payloads).
    const incomingImages = Array.isArray(body.images)
      ? body.images
      : body.image_url
        ? [body.image_url]
        : [];

    const result = await runQuery(
      context.env,
      `
      INSERT INTO menu_items
        (category_id, name, description, price, special_price, special_starts_at, special_ends_at, image_url, is_available, stock_quantity, is_visible, accepts_spice, accepts_addons)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING id;
    `,
      [
        categoryId,
        name,
        (body.description || "").trim(),
        price,
        specialPrice,
        specialStarts,
        specialEnds,
        incomingImages[0] || null,
        isAvailable,
        stockQuantity,
        body.is_visible !== false,
        !!body.accepts_spice,
        !!body.accepts_addons,
      ],
    );

    const newItemId = result.rows[0].id;
    const addonIds = await syncAddonLinks(
      context.env,
      newItemId,
      body.addon_ids,
    );
    const ingredientNames = await syncIngredients(
      context.env,
      newItemId,
      body.ingredients,
    );
    const images = await syncImages(context.env, newItemId, incomingImages);
    await syncSideLinks(context.env, newItemId, body.side_ids);
    await syncDrinkType(context.env, newItemId, body.drink_type);

    await auditMenu(
      context,
      "menu_item_created",
      { id: newItemId, name },
      `Added "${name}" to the menu at ${money(price)}` + (specialPrice !== null ? ` (special ${money(specialPrice)})` : "") + ".",
      [{ label: "Price", from: "none", to: money(price) }],
    );

    return jsonResponse(
      { success: true, id: newItemId, addon_ids: addonIds, ingredients: ingredientNames, images },
      201,
    );
  } catch (err) {
    return jsonResponse(
      { error: "Failed to create menu item.", message: err.message },
      500,
    );
  }
}

export async function onRequestPut(context) {
  const authError = await requireAdmin(context.request, context.env);
  if (authError) return authError;

  try {
    const body = await context.request.json();
    const id = parseInt(body.id, 10);
    if (!Number.isInteger(id))
      return jsonResponse({ error: "A valid item id is required." }, 400);

    const name = (body.name || "").trim();
    const categoryId = parseInt(body.category_id, 10);
    const price = parseFloat(body.price);
    if (
      !name ||
      !Number.isInteger(categoryId) ||
      !Number.isFinite(price) ||
      price < 0
    ) {
      return jsonResponse(
        { error: "Name, category, and a valid price are required." },
        400,
      );
    }
    if (name.length > 100) return jsonResponse({ error: "Item names can be at most 100 characters." }, 400);
    if (price > 100000) return jsonResponse({ error: "That price looks too high - please check it." }, 400);

    const stockResult = parseStockQuantity(body.stock_quantity);
    if (!stockResult.ok) {
      return jsonResponse(
        {
          error:
            "Stock quantity must be left blank (unlimited) or a whole number of 0 or more.",
        },
        400,
      );
    }
    const stockQuantity = stockResult.value;
    const isAvailable = stockQuantity === null ? true : stockQuantity > 0;

    const specialResult = parseSpecialPrice(body.special_price, price);
    if (!specialResult.ok) {
      return jsonResponse(
        {
          error:
            "Special price must be left blank, or a valid amount that's less than the regular price.",
        },
        400,
      );
    }
    const specialPrice = specialResult.value;

    const incomingImages = Array.isArray(body.images)
      ? body.images
      : body.image_url
        ? [body.image_url]
        : [];

    // Validate special start/end datetimes (if provided) and include them
    const startsResult = parseSpecialDate(body.special_starts_at);
    if (!startsResult.ok)
      return jsonResponse({ error: "Invalid special start datetime." }, 400);
    const endsResult = parseSpecialDate(body.special_ends_at);
    if (!endsResult.ok)
      return jsonResponse({ error: "Invalid special end datetime." }, 400);
    const specialStarts = startsResult.value;
    const specialEnds = endsResult.value;
    if (
      specialStarts &&
      specialEnds &&
      new Date(specialEnds) <= new Date(specialStarts)
    ) {
      return jsonResponse(
        { error: "Special end must be after its start." },
        400,
      );
    }

    const beforeRes = await runQuery(
      context.env,
      `SELECT name, category_id, description, price, special_price, special_starts_at, special_ends_at,
              image_url, stock_quantity, is_visible, accepts_spice, accepts_addons
         FROM menu_items WHERE id = $1;`,
      [id],
    );
    const before = beforeRes.rows[0] || {};

    await runQuery(
      context.env,
      `
      UPDATE menu_items SET
        category_id = $1, name = $2, description = $3, price = $4, special_price = $5, special_starts_at = $6, special_ends_at = $7, image_url = $8,
        is_available = $9, stock_quantity = $10, is_visible = $11, accepts_spice = $12, accepts_addons = $13,
        updated_at = NOW()
      WHERE id = $14;
    `,
      [
        categoryId,
        name,
        (body.description || "").trim(),
        price,
        specialPrice,
        specialStarts,
        specialEnds,
        incomingImages[0] || null,
        isAvailable,
        stockQuantity,
        body.is_visible !== false,
        !!body.accepts_spice,
        !!body.accepts_addons,
        id,
      ],
    );

    const addonIds = await syncAddonLinks(context.env, id, body.addon_ids);
    const ingredientNames = await syncIngredients(context.env, id, body.ingredients);
    const images = await syncImages(context.env, id, incomingImages);
    await syncSideLinks(context.env, id, body.side_ids);
    await syncDrinkType(context.env, id, body.drink_type);

    // ---- Audit: menu edits and special edits are logged as separate events ----
    const beforeNorm = {
      ...before,
      price: before.price != null ? Number(before.price) : null,
      special_price: before.special_price != null ? Number(before.special_price) : null,
    };
    const after = {
      name,
      category_id: categoryId,
      description: (body.description || "").trim(),
      price,
      special_price: specialPrice,
      special_starts_at: specialStarts,
      special_ends_at: specialEnds,
      image_url: incomingImages[0] || null,
      stock_quantity: stockQuantity,
      is_visible: body.is_visible !== false,
      accepts_spice: !!body.accepts_spice,
      accepts_addons: !!body.accepts_addons,
    };
    const menuChanges = diffChanges(beforeNorm, after, MENU_FIELDS).map((c) =>
      c.field === "description" ? { ...c, from: "(old text)", to: "(new text)" } : c,
    );
    const specialChanges = diffChanges(beforeNorm, after, SPECIAL_FIELDS);
    const itemRef = { id, name };

    if (menuChanges.length) {
      await auditMenu(context, "menu_item_updated", itemRef, `Menu item "${name}" updated - ${summarizeChanges(menuChanges)}`, menuChanges);
    }
    if (specialChanges.length) {
      const hadSpecial = beforeNorm.special_price !== null;
      const action = after.special_price === null ? "special_removed" : hadSpecial ? "special_updated" : "special_added";
      const text =
        action === "special_removed"
          ? `Special removed from "${name}" (was ${money(beforeNorm.special_price)}).`
          : `${action === "special_added" ? "Special added to" : "Special updated on"} "${name}" - ${summarizeChanges(specialChanges)}`;
      await auditMenu(context, action, itemRef, text, specialChanges);
    }

    return jsonResponse({ success: true, id, addon_ids: addonIds, ingredients: ingredientNames, images });
  } catch (err) {
    return jsonResponse(
      { error: "Failed to update menu item.", message: err.message },
      500,
    );
  }
}

export async function onRequestDelete(context) {
  const authError = await requireAdmin(context.request, context.env);
  if (authError) return authError;

  const url = new URL(context.request.url);
  const id = parseInt(url.searchParams.get("id"), 10);
  if (!Number.isInteger(id))
    return jsonResponse({ error: "A valid id is required." }, 400);

  const existing = await runQuery(context.env, "SELECT name, price FROM menu_items WHERE id = $1;", [id]);
  await runQuery(context.env, "DELETE FROM menu_items WHERE id = $1;", [id]);
  if (existing.rows[0]) {
    await auditMenu(context, "menu_item_deleted", { id, name: existing.rows[0].name }, `Menu item "${existing.rows[0].name}" (${money(existing.rows[0].price)}) deleted.`);
  }
  return jsonResponse({ success: true });
}
