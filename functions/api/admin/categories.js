/**
 * functions/api/admin/categories.js
 * -----------------------------------------------------------------------
 * GET  /api/admin/categories       -> list all categories
 * POST /api/admin/categories       -> create a category { name, sort_order }
 * All routes require the admin bearer token.
 * -----------------------------------------------------------------------
 */
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { requireAdmin } from "../../_lib/auth.js";

function slugify(name) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

export async function onRequestGet(context) {
  const authError = await requireAdmin(context.request, context.env);
  if (authError) return authError;

  const result = await runQuery(
    context.env,
    "SELECT id, name, slug, sort_order FROM categories ORDER BY sort_order ASC, name ASC;",
  );
  return jsonResponse({ categories: result.rows });
}

export async function onRequestPost(context) {
  const authError = await requireAdmin(context.request, context.env);
  if (authError) return authError;

  try {
    const { name, sort_order } = await context.request.json();
    const trimmedName = (name || "").trim();
    if (!trimmedName)
      return jsonResponse({ error: "Category name is required." }, 400);

    const slug = slugify(trimmedName);
    const result = await runQuery(
      context.env,
      `
      INSERT INTO categories (name, slug, sort_order) VALUES ($1, $2, $3)
      ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
      RETURNING id, name, slug, sort_order;
    `,
      [trimmedName, slug, Number.isFinite(sort_order) ? sort_order : 0],
    );

    return jsonResponse({ success: true, category: result.rows[0] }, 201);
  } catch (err) {
    return jsonResponse(
      { error: "Failed to create category.", message: err.message },
      500,
    );
  }
}
