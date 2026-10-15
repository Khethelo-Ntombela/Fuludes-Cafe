// GET /api/admin/ingredient-suggestions
// An ingredient is suggested for stocking up only when BOTH are true:
//   1. Meals that use it sold WEEKLY_USAGE_THRESHOLD or more units in the last 7 days
//      (each unit sold counts as one use of the ingredient).
//   2. At least one meal that uses it has fewer than STOCK_THRESHOLD left.
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { requireAdmin } from "../../_lib/auth.js";

const WEEK_DAYS = 7;
const WEEKLY_USAGE_THRESHOLD = 30;
const STOCK_THRESHOLD = 30;

export async function onRequestGet(context) {
  const { request, env } = context;
  const authError = await requireAdmin(request, env);
  if (authError) return authError;

  try {
    // 1. Units sold per meal in the last 7 days
    const soldRes = await runQuery(env, `
      SELECT
        oi.menu_item_id,
        SUM(oi.quantity) AS units_sold
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE o.created_at >= NOW() - INTERVAL '${WEEK_DAYS} days'
        AND o.payment_status = 'paid'
        AND o.status <> 'Cancelled'
      GROUP BY oi.menu_item_id
      HAVING SUM(oi.quantity) > 0
    `);
    const soldMap = new Map(
      soldRes.rows.map(r => [r.menu_item_id, parseInt(r.units_sold, 10)])
    );

    // 2. Every meal that has ingredients, with its current stock
    const ingredientRes = await runQuery(env, `
      SELECT di.ingredient_name, di.menu_item_id, mi.name AS dish_name, mi.stock_quantity
      FROM dish_ingredients di
      JOIN menu_items mi ON mi.id = di.menu_item_id
    `);

    // Urgency for a low meal = days of stock left at this week's selling pace:
    //   high   - runs out within 2 days
    //   medium - runs out within a week
    //   low    - slow seller (or not selling), stock will last
    const RANK = { high: 3, medium: 2, low: 1 };
    function dishUrgency(stock, unitsSold) {
      const perDay = unitsSold / WEEK_DAYS;
      if (perDay <= 0) return { level: "low", perDay: 0, daysLeft: null };
      const daysLeft = stock / perDay;
      const level = daysLeft <= 2 ? "high" : daysLeft <= 7 ? "medium" : "low";
      return { level, perDay, daysLeft };
    }

    // 3. Group by ingredient: total weekly uses across all meals, plus the low-stock meals
    const ingredientMap = new Map();
    for (const row of ingredientRes.rows) {
      const { ingredient_name, menu_item_id, dish_name, stock_quantity } = row;
      const unitsSold = soldMap.get(menu_item_id) || 0;

      if (!ingredientMap.has(ingredient_name)) {
        ingredientMap.set(ingredient_name, {
          ingredient_name,
          weekly_uses: 0,
          dish_count: 0,
          urgency: "low",
          min_days_left: null,
          dishes: []
        });
      }
      const ing = ingredientMap.get(ingredient_name);
      ing.weekly_uses += unitsSold;

      const tracked = stock_quantity !== null && stock_quantity !== undefined;
      if (!tracked || Number(stock_quantity) >= STOCK_THRESHOLD) continue;

      const u = dishUrgency(Number(stock_quantity), unitsSold);
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
        stock_quantity: Number(stock_quantity),
        days_left: u.daysLeft === null ? null : Math.round(u.daysLeft * 10) / 10,
        urgency: u.level
      });
    }

    // 4. Keep only ingredients meeting BOTH conditions
    const qualifying = [...ingredientMap.values()].filter(
      ing => ing.weekly_uses >= WEEKLY_USAGE_THRESHOLD && ing.dish_count > 0
    );

    // 5. Most urgent first; within a level, the soonest to run out, then most used
    qualifying.sort(
      (a, b) =>
        RANK[b.urgency] - RANK[a.urgency] ||
        (a.min_days_left ?? Infinity) - (b.min_days_left ?? Infinity) ||
        b.weekly_uses - a.weekly_uses
    );

    return jsonResponse({
      ingredients: qualifying,
      days: WEEK_DAYS,
      weekly_usage_threshold: WEEKLY_USAGE_THRESHOLD,
      stock_threshold: STOCK_THRESHOLD
    });

  } catch (err) {
    return jsonResponse(
      { error: "Failed to load ingredient suggestions.", message: err.message },
      500
    );
  }
}
