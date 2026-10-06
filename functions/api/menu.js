/**
 * functions/api/menu.js
 * -----------------------------------------------------------------------
 * GET /api/menu
 * Public, read-only endpoint the customer site calls on page load.
 * Returns everything main.js needs to render the category tabs and
 * menu cards in one round trip: categories, visible+in-stock-aware menu
 * items (each with the addons it accepts attached), and the global
 * spice-level list.
 *
 * Items that the admin has hidden (is_visible = false, e.g. a dessert
 * that isn't on offer today) are excluded entirely. Items that are
 * visible but temporarily sold out (is_available = false) ARE included
 * so the frontend can render a "Sold Out" badge instead of just hiding
 * them.
 *
 * Category tabs are data-driven the same way: a category is only
 * returned (and so only shows up as a tab) if it currently has at least
 * one visible item in it. Categories like Starters or Dessert that
 * aren't offered every day simply disappear from the menu on days
 * nothing in them is turned on, instead of showing an empty tab - the
 * moment admin makes one dish in that category visible again, its tab
 * reappears automatically. Being sold out doesn't affect this; only
 * is_visible does, same as for individual dishes.
 *
 * special_price (nullable) is also included per item - when set it's the
 * item's real selling price (see functions/api/order.js), with `price`
 * kept as the "was" price so the frontend can show the discount.
 * -----------------------------------------------------------------------
 */
import { runQuery, jsonResponse } from "../_lib/db.js";

export async function onRequest(context) {
  if (context.request.method !== "GET") {
    return jsonResponse({ error: "Method not allowed. Use GET." }, 405);
  }

  try {
    const [categoriesResult, itemsResult, addonLinksResult, spiceResult, imagesResult, sideLinksResult] = await Promise.all([
      runQuery(context.env, `
        SELECT DISTINCT c.id, c.name, c.slug, c.sort_order
        FROM categories c
        JOIN menu_items m ON m.category_id = c.id AND m.is_visible = TRUE
        ORDER BY c.sort_order ASC, c.name ASC;
      `),
      runQuery(context.env, `
        SELECT id, category_id, name, description, price, special_price, special_starts_at, special_ends_at, image_url,
                 is_available, accepts_spice, accepts_addons, sort_order, drink_type
        FROM menu_items
        WHERE is_visible = TRUE
        ORDER BY sort_order ASC, name ASC;
      `).catch(() => runQuery(context.env, `
        SELECT id, category_id, name, description, price, special_price, special_starts_at, special_ends_at, image_url,
                 is_available, accepts_spice, accepts_addons, sort_order
        FROM menu_items
        WHERE is_visible = TRUE
        ORDER BY sort_order ASC, name ASC;
      `)), // drink_type column not created yet (migration 008)
      runQuery(context.env, `
        SELECT mia.menu_item_id, a.id, a.name, a.price
        FROM menu_item_addons mia
        JOIN addons a ON a.id = mia.addon_id
        WHERE a.is_active = TRUE
        ORDER BY a.name ASC;
      `),
      runQuery(context.env, "SELECT id, name FROM spice_levels ORDER BY sort_order ASC, name ASC;"),
      runQuery(context.env, "SELECT menu_item_id, image_url FROM menu_item_images ORDER BY sort_order ASC, id ASC;"),
      runQuery(context.env, `
        SELECT mis.menu_item_id, s.id, s.name
        FROM menu_item_sides mis
        JOIN sides s ON s.id = mis.side_id
        WHERE s.is_active = TRUE
        ORDER BY s.name ASC;
      `).catch(() => ({ rows: [] })) // sides table not created yet (migration 006)
    ]);

    // Free choice-of-side options per dish.
    const sidesByItem = {};
    for (const row of sideLinksResult.rows) {
      (sidesByItem[row.menu_item_id] || (sidesByItem[row.menu_item_id] = [])).push({ id: row.id, name: row.name });
    }

    // Group addons by menu_item_id so each item carries its own addon list.
    const addonsByItem = {};
    for (const row of addonLinksResult.rows) {
      const list = addonsByItem[row.menu_item_id] || (addonsByItem[row.menu_item_id] = []);
      list.push({ id: row.id, name: row.name, price: parseFloat(row.price) });
    }

    // Group the full photo gallery by menu_item_id (cover photo first).
    const imagesByItem = {};
    for (const row of imagesResult.rows) {
      const list = imagesByItem[row.menu_item_id] || (imagesByItem[row.menu_item_id] = []);
      list.push(row.image_url);
    }

    const now = new Date();
    const items = itemsResult.rows.map(item => {
      const price = parseFloat(item.price);
      const specialPrice = item.special_price !== null ? parseFloat(item.special_price) : null;
      const starts = item.special_starts_at ? new Date(item.special_starts_at) : null;
      const ends = item.special_ends_at ? new Date(item.special_ends_at) : null;
      const isOnSpecial = specialPrice !== null && (!starts || now >= starts) && (!ends || now < ends);
      return {
        ...item,
        price,
        special_price: specialPrice,
        special_starts_at: starts ? starts.toISOString() : null,
        special_ends_at: ends ? ends.toISOString() : null,
        is_on_special: isOnSpecial,
        effective_price: isOnSpecial ? specialPrice : price,
        addons: addonsByItem[item.id] || [],
        sides: sidesByItem[item.id] || [],
        images: imagesByItem[item.id] || (item.image_url ? [item.image_url] : [])
      };
    });

    return jsonResponse({
      categories: categoriesResult.rows,
      items,
      spice_levels: spiceResult.rows
    }, 200, { "Cache-Control": "no-store, max-age=0" });
  } catch (err) {
    return jsonResponse({ error: "Failed to load menu.", message: err.message }, 500);
  }
}
