/**
 * functions/api/admin/categories.js
 * -----------------------------------------------------------------------
 * GET  /api/admin/categories       -> list all categories
 * POST /api/admin/categories       -> create a category { name, sort_order }
 * DELETE /api/admin/categories     -> delete an empty category { id }
 * All routes require the admin bearer token.
 * -----------------------------------------------------------------------
 */
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { requireAdmin } from "../../_lib/auth.js";
import { logAudit } from "../../_lib/audit.js";

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

/**
 * DELETE /api/admin/categories  { id }
 * Removes a category. Refused while dishes are still in it (they'd lose
 * their menu tab) - the response names them so the admin can move or
 * delete them first.
 */
export async function onRequestDelete(context) {
  const authError = await requireAdmin(context.request, context.env);
  if (authError) return authError;

  try {
    const { id } = await context.request.json();
    const categoryId = parseInt(id, 10);
    if (!Number.isInteger(categoryId)) return jsonResponse({ error: "A valid category id is required." }, 400);

    const dishes = await runQuery(
      context.env,
      "SELECT name FROM menu_items WHERE category_id = $1 ORDER BY name LIMIT 6;",
      [categoryId],
    );
    if (dishes.rows.length) {
      const total = Number(
        (await runQuery(context.env, "SELECT COUNT(*)::int AS n FROM menu_items WHERE category_id = $1;", [categoryId])).rows[0].n,
      );
      const names = dishes.rows.map((d) => d.name).join(", ");
      return jsonResponse(
        {
          error: `This category still has ${total} dish${total === 1 ? "" : "es"} (${names}${total > dishes.rows.length ? ", …" : ""}). Move them to another category or delete them first.`,
        },
        400,
      );
    }

    const removed = await runQuery(context.env, "DELETE FROM categories WHERE id = $1 RETURNING name;", [categoryId]);
    if (!removed.rows.length) return jsonResponse({ error: "Category not found." }, 404);
    await logAudit(context.env, {
      actor_type: "admin",
      actor_role: "admin",
      action: "category_deleted",
      target_type: "category",
      target_id: categoryId,
      details: { name: removed.rows[0].name },
    });
    return jsonResponse({ success: true });
  } catch (err) {
    return jsonResponse({ error: "Failed to delete category.", message: err.message }, 500);
  }
}
