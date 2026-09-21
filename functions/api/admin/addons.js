/**
 * functions/api/admin/addons.js
 * -----------------------------------------------------------------------
 * Manages the two global customization catalogs an admin edits once and
 * then attaches to individual dishes:
 *   - addons: paid extras (e.g. "Extra Chips R25")
 *   - spice_levels: free spice choices (e.g. "Mild", "Hot")
 *
 * GET    /api/admin/addons                 -> { addons, spice_levels }
 * POST   /api/admin/addons                 -> create an addon { name, price }
 * POST   /api/admin/addons?type=spice      -> create a spice level { name }
 * DELETE /api/admin/addons?id=5            -> remove an addon
 * DELETE /api/admin/addons?type=spice&id=2 -> remove a spice level
 * -----------------------------------------------------------------------
 */
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { requireAdmin } from "../../_lib/auth.js";

export async function onRequestGet(context) {
  const authError = await requireAdmin(context.request, context.env);
  if (authError) return authError;

  const [addonsResult, spiceResult] = await Promise.all([
    runQuery(
      context.env,
      "SELECT id, name, price, is_active FROM addons ORDER BY name ASC;",
    ),
    runQuery(
      context.env,
      "SELECT id, name, sort_order FROM spice_levels ORDER BY sort_order ASC, name ASC;",
    ),
  ]);

  return jsonResponse({
    addons: addonsResult.rows,
    spice_levels: spiceResult.rows,
  });
}

export async function onRequestPost(context) {
  const authError = await requireAdmin(context.request, context.env);
  if (authError) return authError;

  const url = new URL(context.request.url);
  const isSpice = url.searchParams.get("type") === "spice";

  try {
    const body = await context.request.json();
    const name = (body.name || "").trim();
    if (!name) return jsonResponse({ error: "Name is required." }, 400);

    if (isSpice) {
      const result = await runQuery(
        context.env,
        `
        INSERT INTO spice_levels (name, sort_order) VALUES ($1, $2)
        ON CONFLICT (name) DO NOTHING
        RETURNING id, name, sort_order;
      `,
        [name, Number.isFinite(body.sort_order) ? body.sort_order : 0],
      );
      return jsonResponse(
        { success: true, spice_level: result.rows[0] || null },
        201,
      );
    }

    const price = parseFloat(body.price);
    const result = await runQuery(
      context.env,
      `
      INSERT INTO addons (name, price, is_active) VALUES ($1, $2, TRUE)
      RETURNING id, name, price, is_active;
    `,
      [name, Number.isFinite(price) ? price : 0],
    );
    return jsonResponse({ success: true, addon: result.rows[0] }, 201);
  } catch (err) {
    return jsonResponse(
      { error: "Failed to save.", message: err.message },
      500,
    );
  }
}

export async function onRequestDelete(context) {
  const authError = await requireAdmin(context.request, context.env);
  if (authError) return authError;

  const url = new URL(context.request.url);
  const id = parseInt(url.searchParams.get("id"), 10);
  const isSpice = url.searchParams.get("type") === "spice";
  if (!Number.isInteger(id))
    return jsonResponse({ error: "A valid id is required." }, 400);

  const table = isSpice ? "spice_levels" : "addons";
  await runQuery(context.env, `DELETE FROM ${table} WHERE id = $1;`, [id]);
  return jsonResponse({ success: true });
}
