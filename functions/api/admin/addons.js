// Global addons and sides, edited once and attached to dishes.
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { requireAdmin } from "../../_lib/auth.js";

export async function onRequestGet(context) {
  const authError = await requireAdmin(context.request, context.env);
  if (authError) return authError;

  const [addonsResult, spiceResult, sidesResult] = await Promise.all([
    runQuery(
      context.env,
      "SELECT id, name, price, is_active FROM addons ORDER BY name ASC;",
    ),
    runQuery(
      context.env,
      "SELECT id, name, sort_order FROM spice_levels ORDER BY sort_order ASC, name ASC;",
    ),
    runQuery(
      context.env,
      "SELECT id, name, is_active FROM sides ORDER BY name ASC;",
    ).catch(() => ({ rows: [] })), // sides table not created yet (migration 006)
  ]);

  return jsonResponse({
    addons: addonsResult.rows,
    spice_levels: spiceResult.rows,
    sides: sidesResult.rows,
  });
}

export async function onRequestPost(context) {
  const authError = await requireAdmin(context.request, context.env);
  if (authError) return authError;

  const url = new URL(context.request.url);
  const isSpice = url.searchParams.get("type") === "spice";
  const isSide = url.searchParams.get("type") === "side";

  try {
    const body = await context.request.json();
    const name = (body.name || "").trim();
    if (!name) return jsonResponse({ error: "Name is required." }, 400);
    if (name.length > 60) return jsonResponse({ error: "Names can be at most 60 characters." }, 400);

    if (isSide) {
      const result = await runQuery(
        context.env,
        `INSERT INTO sides (name) VALUES ($1)
         ON CONFLICT (name) DO UPDATE SET is_active = TRUE
         RETURNING id, name, is_active;`,
        [name],
      );
      return jsonResponse({ success: true, side: result.rows[0] }, 201);
    }

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
    if (body.price !== undefined && body.price !== "" && (!Number.isFinite(price) || price < 0 || price > 100000)) {
      return jsonResponse({ error: "Please enter a valid price (R0 or more)." }, 400);
    }
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
  const type = url.searchParams.get("type");
  const isSpice = type === "spice";
  if (!Number.isInteger(id))
    return jsonResponse({ error: "A valid id is required." }, 400);

  const table = isSpice ? "spice_levels" : type === "side" ? "sides" : "addons";
  await runQuery(context.env, `DELETE FROM ${table} WHERE id = $1;`, [id]);
  return jsonResponse({ success: true });
}
