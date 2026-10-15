// GET /api/admin/ingredient-suggestions?days=7
// "Low stock" is always LOW_STOCK_THRESHOLD or fewer left - no filter to pick.
const LOW_STOCK_THRESHOLD = 10;
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { requireAdmin } from "../../_lib/auth.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const authError = await requireAdmin(request, env);
  if (authError) return authError;

  const url = new URL(request.url);
  const days = Math.max(1, Math.min(365, parseInt(url.searchParams.get("days") || "7", 10)));
  const lowStockThreshold = LOW_STOCK_THRESHOLD;

  try {
    // 1
    const soldWellRes = await runQuery(env, `
      SELECT
        oi.menu_item_id,
        SUM(oi.quantity) AS units_sold
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE o.created_at >= NOW() - INTERVAL '${days} days'
        AND o.payment_status = 'paid'
        AND o.status <> 'Cancelled'
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

    // 3. Only LOW-STOCK dishes are flagged. How fast they sell decides the urgency.
    const lowStockIds = [...lowStockMap.keys()];
    if (lowStockIds.length === 0) {
      return jsonResponse({ ingredients: [], days, low_stock_threshold: lowStockThreshold });
    }

    // Urgency from "days of stock left" = stock now / units sold per day:
    //   high   - runs out within 2 days (fast seller, or already at 0 and selling)
    //   medium - runs out within a week
    //   low    - slow seller (or not selling at all), stock will last
    const RANK = { high: 3, medium: 2, low: 1 };
    function dishUrgency(stock, unitsSold) {
      const perDay = unitsSold / days;
      if (perDay <= 0) return { level: "low", perDay: 0, daysLeft: null };
      const daysLeft = stock / perDay;
      const level = daysLeft <= 2 ? "high" : daysLeft <= 7 ? "medium" : "low";
      return { level, perDay, daysLeft };
    }

    // 4. Ingredients used by those low-stock dishes
    const placeholders = lowStockIds.map((_, i) => `$${i + 1}`).join(",");
    const ingredientRes = await runQuery(env, `
      SELECT di.ingredient_name, di.menu_item_id, mi.name AS dish_name, mi.stock_quantity
      FROM dish_ingredients di
      JOIN menu_items mi ON mi.id = di.menu_item_id
      WHERE di.menu_item_id IN (${placeholders})
    `, lowStockIds);

    // 5. Aggregate by ingredient - an ingredient takes its most urgent dish's level
    const ingredientMap = new Map();
    for (const row of ingredientRes.rows) {
      const { ingredient_name, menu_item_id, dish_name, stock_quantity } = row;
      const unitsSold = soldWellMap.get(menu_item_id)?.units_sold || 0;
      const u = dishUrgency(Number(stock_quantity), unitsSold);

      if (!ingredientMap.has(ingredient_name)) {
        ingredientMap.set(ingredient_name, {
          ingredient_name,
          dish_count: 0,
          urgency: "low",
          min_days_left: null,
          dishes: []
        });
      }
      const ing = ingredientMap.get(ingredient_name);
      ing.dish_count += 1;
      if (RANK[u.level] > RANK[ing.urgency]) ing.urgency = u.level;
      if (u.daysLeft !== null && (ing.min_days_left === null || u.daysLeft < ing.min_days_left)) {
        ing.min_days_left = u.daysLeft;
      }
      ing.dishes.push({
        menu_item_id,
        name: dish_name,
        units_sold: unitsSold,
        sold_per_day: Math.round(u.perDay * 10) / 10,
        stock_quantity: stock_quantity ?? null,
        days_left: u.daysLeft === null ? null : Math.round(u.daysLeft * 10) / 10,
        urgency: u.level
      });
    }

    // 6. Most urgent first; within a level, the soonest to run out first
    const sortedIngredients = [...ingredientMap.values()].sort(
      (a, b) =>
        RANK[b.urgency] - RANK[a.urgency] ||
        (a.min_days_left ?? Infinity) - (b.min_days_left ?? Infinity) ||
        b.dish_count - a.dish_count
    );

    return jsonResponse({
      ingredients: sortedIngredients,
      days,
      low_stock_threshold: lowStockThreshold,
      trigger_dish_count: lowStockIds.length
    });

  } catch (err) {
    return jsonResponse(
      { error: "Failed to load ingredient suggestions.", message: err.message },
      500
    );
  }
}