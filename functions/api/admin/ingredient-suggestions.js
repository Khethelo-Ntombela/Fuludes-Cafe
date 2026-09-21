/**
 * functions/api/admin/ingredient-suggestions.js
 * -----------------------------------------------------------------------
 * GET /api/admin/ingredient-suggestions?days=7&low_stock_threshold=5
 * Returns ingredients ranked by how many "worth watching" dishes use them.
 * -----------------------------------------------------------------------
 */
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { requireAdmin } from "../../_lib/auth.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const authError = await requireAdmin(request, env);
  if (authError) return authError;

  const url = new URL(request.url);
  const days = Math.max(1, Math.min(365, parseInt(url.searchParams.get("days") || "7", 10)));
  const lowStockThreshold = Math.max(0, parseInt(url.searchParams.get("low_stock_threshold") || "5", 10));

  try {
    // 1. Get dishes that sold well in the recent window
    const soldWellRes = await runQuery(env, `
      SELECT
        oi.menu_item_id,
        SUM(oi.quantity) AS units_sold
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE o.created_at >= NOW() - INTERVAL '${days} days'
        AND o.status NOT IN ('Cancelled')
      GROUP BY oi.menu_item_id
      HAVING SUM(oi.quantity) > 0
    `);
    const soldWellMap = new Map(
      soldWellRes.rows.map(r => [r.menu_item_id, { units_sold: parseInt(r.units_sold, 10) }])
    );

    // 2. Get dishes with low stock
    const lowStockRes = await runQuery(env, `
      SELECT id, name, stock_quantity
      FROM menu_items
      WHERE stock_quantity IS NOT NULL
        AND stock_quantity <= $1
    `, [lowStockThreshold]);
    const lowStockMap = new Map(
      lowStockRes.rows.map(r => [r.id, { name: r.name, stock_quantity: r.stock_quantity }])
    );

    // 3. Combine trigger dishes (sold well OR low stock)
    const allTriggerDishIds = new Set([
      ...soldWellMap.keys(),
      ...lowStockMap.keys()
    ]);

    if (allTriggerDishIds.size === 0) {
      return jsonResponse({ ingredients: [], days, low_stock_threshold: lowStockThreshold });
    }

    // 4. Get ingredient usage for trigger dishes
    const placeholders = [...allTriggerDishIds].map((_, i) => `$${i + 1}`).join(",");
    const ingredientRes = await runQuery(env, `
      SELECT
        di.ingredient_name,
        di.menu_item_id,
        mi.name AS dish_name,
        mi.stock_quantity
      FROM dish_ingredients di
      JOIN menu_items mi ON mi.id = di.menu_item_id
      WHERE di.menu_item_id IN (${placeholders})
    `, [...allTriggerDishIds]);

    // 5. Aggregate by ingredient
    const ingredientMap = new Map(); // ingredient_name -> { dish_count, urgency_score, dishes: [] }
    
    for (const row of ingredientRes.rows) {
      const { ingredient_name, menu_item_id, dish_name, stock_quantity } = row;
      const soldWellData = soldWellMap.get(menu_item_id);
      const lowStockData = lowStockMap.get(menu_item_id);
      
      const reasons = [];
      if (soldWellData) reasons.push(`sold_well (${soldWellData.units_sold} units in ${days}d)`);
      if (lowStockData) reasons.push(`low_stock (${lowStockData.stock_quantity} left)`);
      
      const urgencyIncrement = soldWellData && lowStockData ? 2 : 1; // both = higher urgency

      if (!ingredientMap.has(ingredient_name)) {
        ingredientMap.set(ingredient_name, {
          ingredient_name,
          dish_count: 0,
          urgency_score: 0,
          dishes: []
        });
      }

      const ing = ingredientMap.get(ingredient_name);
      ing.dish_count += 1;
      ing.urgency_score += urgencyIncrement;
      ing.dishes.push({
        menu_item_id,
        name: dish_name,
        units_sold: soldWellData?.units_sold || 0,
        stock_quantity: stock_quantity ?? null,
        reasons
      });
    }

    // 6. Sort by urgency_score desc, then dish_count desc
    const sortedIngredients = [...ingredientMap.values()]
      .sort((a, b) => b.urgency_score - a.urgency_score || b.dish_count - a.dish_count);

    return jsonResponse({
      ingredients: sortedIngredients,
      days,
      low_stock_threshold: lowStockThreshold,
      trigger_dish_count: allTriggerDishIds.size
    });

  } catch (err) {
    return jsonResponse(
      { error: "Failed to load ingredient suggestions.", message: err.message },
      500
    );
  }
}