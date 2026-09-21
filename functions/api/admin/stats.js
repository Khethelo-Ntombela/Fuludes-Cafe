/**
 * functions/api/admin/stats.js
 * -----------------------------------------------------------------------
 * GET /api/admin/stats
 * Powers the admin "Your Sales" tab: a total order count, plus how many
 * orders touched each menu category (an order counts once per category
 * even if it had several items from that category - so the slices add
 * up to something meaningful rather than double-counting line items).
 *
 * These numbers are always computed live from the `orders`/`order_items`
 * tables, so running "Clear History" (functions/api/admin/orders.js
 * onRequestDelete) immediately lowers what shows up here too.
 * -----------------------------------------------------------------------
 */
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { requireAdmin } from "../../_lib/auth.js";

function parseDateInput(value, endOfDay = false) {
  if (!value) return null;
  const base = endOfDay ? `${value}T23:59:59.999` : `${value}T00:00:00`;
  const date = new Date(base);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseMonthsParam(value) {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveRange(url) {
  const params = new URL(url).searchParams;
  const months = parseMonthsParam(params.get("months"));
  if (months.length > 0) {
    return { start: null, end: null, period: "months", months };
  }

  const period = params.get("period") || "last_6_months";
  const customFrom = parseDateInput(params.get("from"));
  const customTo = parseDateInput(params.get("to"), true);

  if (period === "custom" && customFrom && customTo) {
    return { start: customFrom, end: customTo, period: "custom" };
  }

  const now = new Date();
  if (period === "current_month") {
    const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const end = new Date(
      now.getFullYear(),
      now.getMonth() + 1,
      1,
    ).toISOString();
    return { start, end, period: "current_month" };
  }

  if (period === "last_3_months") {
    const start = new Date(
      now.getFullYear(),
      now.getMonth() - 2,
      1,
    ).toISOString();
    const end = new Date(
      now.getFullYear(),
      now.getMonth() + 1,
      1,
    ).toISOString();
    return { start, end, period: "last_3_months" };
  }

  const start = new Date(
    now.getFullYear(),
    now.getMonth() - 5,
    1,
  ).toISOString();
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();
  return { start, end, period: "last_6_months" };
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const authError = await requireAdmin(request, env);
  if (authError) return authError;

  try {
    const { start, end, period, months } = resolveRange(request.url);
    const monthFilter =
      months && months.length > 0
        ? "AND TO_CHAR(created_at, 'YYYY-MM') = ANY($3::text[])"
        : "";
    const monthFilterForCategory =
      months && months.length > 0
        ? "AND TO_CHAR(o.created_at, 'YYYY-MM') = ANY($3::text[])"
        : "";

    const [summaryResult, monthlyResult, categoryResult] = await Promise.all([
      runQuery(
        env,
        `
        SELECT
          COUNT(*)::int AS total_orders,
          COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN total_amount ELSE 0 END)::numeric(12,2), 0) AS total_revenue
        FROM orders
        WHERE payment_status = 'paid'
          AND ($1::timestamptz IS NULL OR created_at >= $1)
          AND ($2::timestamptz IS NULL OR created_at < $2)
          ${monthFilter};
      `,
        months && months.length > 0 ? [start, end, months] : [start, end],
      ),
      runQuery(
        env,
        `
        SELECT
          TO_CHAR(created_at, 'YYYY-MM') AS month_key,
          COUNT(*)::int AS order_count,
          COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN total_amount ELSE 0 END)::numeric(12,2), 0) AS revenue
        FROM orders
        WHERE payment_status = 'paid'
          AND ($1::timestamptz IS NULL OR created_at >= $1)
          AND ($2::timestamptz IS NULL OR created_at < $2)
          ${monthFilter}
        GROUP BY month_key
        ORDER BY month_key ASC;
      `,
        months && months.length > 0 ? [start, end, months] : [start, end],
      ),
      runQuery(
        env,
        `
        SELECT c.name AS category_name, COUNT(DISTINCT oi.order_id)::int AS order_count
        FROM order_items oi
        JOIN menu_items mi ON mi.id = oi.menu_item_id
        JOIN categories c ON c.id = mi.category_id
        JOIN orders o ON o.id = oi.order_id
        WHERE ($1::timestamptz IS NULL OR o.created_at >= $1)
          AND ($2::timestamptz IS NULL OR o.created_at < $2)
          AND o.payment_status = 'paid'
          ${monthFilterForCategory}
        GROUP BY c.name
        ORDER BY order_count DESC;
      `,
        months && months.length > 0 ? [start, end, months] : [start, end],
      ),
    ]);

    const summary = summaryResult.rows[0] || {};
    const monthlyRows = monthlyResult.rows || [];
    const latestMonth =
      monthlyRows.length > 0 ? monthlyRows[monthlyRows.length - 1] : null;

    return jsonResponse({
      total_orders: summary.total_orders || 0,
      total_revenue: Number(summary.total_revenue || 0),
      monthly_orders: latestMonth?.order_count || 0,
      monthly_revenue: Number(latestMonth?.revenue || 0),
      monthly_breakdown: monthlyRows.map((row) => ({
        month: row.month_key,
        order_count: row.order_count,
        revenue: Number(row.revenue || 0),
      })),
      categories: categoryResult.rows,
      period,
      auto_reset_months: 6,
    });
  } catch (err) {
    return jsonResponse(
      { error: "Failed to load sales stats.", message: err.message },
      500,
    );
  }
}
