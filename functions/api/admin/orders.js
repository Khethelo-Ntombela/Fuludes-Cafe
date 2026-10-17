// GET /api/admin/orders
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { requireAdmin } from "../../_lib/auth.js";
import { ensureCancelledByColumn } from "../../_lib/orderCancel.js";
import { ensureScheduleColumns } from "../../_lib/scheduledOrders.js";
import { priceUnpaidOrders, UNPAID_ORDER_HOURS } from "../../_lib/repriceOrder.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const authError = await requireAdmin(request, env);
  if (authError) return authError;

  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const paymentStatus = url.searchParams.get("payment_status");
  const refundFilter = url.searchParams.get("refund_needed");
  const search = (url.searchParams.get("search") || "").trim();
  const limit = Math.min(
    parseInt(url.searchParams.get("limit"), 10) || 30,
    100,
  );
  const offset = Math.max(parseInt(url.searchParams.get("offset"), 10) || 0, 0);

  try {
    // Order History never lists unpaid orders (payment still awaiting, or failed)
    const asksForUnpaid = paymentStatus === "awaiting" || paymentStatus === "failed";
    const conditions = asksForUnpaid
      ? []
      : [`payment_status NOT IN ('awaiting', 'failed')`];
    const params = [];
    // Unpaid orders expire after UNPAID_ORDER_HOURS, same as on the customer's side.
        // (A table-booking pre-order is exempt: it can legitimately be paid days ahead of the booking.)
    if (asksForUnpaid) {
      conditions.push(
        `(created_at > NOW() - INTERVAL '${UNPAID_ORDER_HOURS} hours' OR EXISTS (SELECT 1 FROM customer_reservations r WHERE r.advance_order_id = orders.id))`,
      );
    }

    if (
      status &&
      [
        "New",
        "Preparing",
        "Ready",
        "Collection",
        "Delivery",
        "Out for Delivery",
        "Completed",
        "Cancelled",
      ].includes(status)
    ) {
      if (status === "Delivery") {
        conditions.push(`status IN ('Delivery', 'Out for Delivery')`);
      } else {
        params.push(status);
        conditions.push(`status = $${params.length}`);
      }
    }
    if (
      paymentStatus &&
      ["paid", "awaiting", "failed", "refunded"].includes(paymentStatus)
    ) {
      params.push(paymentStatus);
      conditions.push(`payment_status = $${params.length}`);
    }
    if (refundFilter === "true" || refundFilter === "false") {
      params.push(refundFilter === "true");
      conditions.push(`refund_needed = $${params.length}`);
    }
    // Optional: only orders placed on or after this date (used by the Reports tab)
    const since = url.searchParams.get("since");
    if (since && !Number.isNaN(Date.parse(since))) {
      params.push(new Date(since).toISOString());
      conditions.push(`created_at >= $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      const likeIndex = params.length;
      const searchAsInt = parseInt(search, 10);
      if (Number.isInteger(searchAsInt) && String(searchAsInt) === search) {
        params.push(searchAsInt);
        conditions.push(
          `(customer_name ILIKE $${likeIndex} OR customer_phone ILIKE $${likeIndex} OR id = $${params.length})`,
        );
      } else {
        conditions.push(
          `(customer_name ILIKE $${likeIndex} OR customer_phone ILIKE $${likeIndex})`,
        );
      }
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit);
    const limitIndex = params.length;
    params.push(offset);
    const offsetIndex = params.length;

    await ensureCancelledByColumn(env);
    await ensureScheduleColumns(env);
    const ordersResult = await runQuery(
      env,
      `
      SELECT id, customer_name, customer_phone, order_type, delivery_address, table_number,
             pickup_time, special_instructions, total_amount,
             CASE WHEN status = 'Out for Delivery' THEN 'Delivery' ELSE status END AS status,
             payment_method, payment_status, payment_ref, refund_needed, refund_processed_at, refund_ref, refund_error, cancelled_by, cancel_reason, created_at, out_for_delivery_at, delivered_at
      FROM orders
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${limitIndex} OFFSET $${offsetIndex};
    `,
      params,
    );

    const orderIds = ordersResult.rows.map((o) => o.id);
    let itemsByOrder = {};
    if (orderIds.length > 0) {
      const itemsResult = await runQuery(
        env,
        `
        SELECT order_id, item_name, item_price, quantity, spice_level, extras, subtotal
        FROM order_items WHERE order_id = ANY($1::int[]) ORDER BY id ASC;
      `,
        [orderIds],
      );
      for (const row of itemsResult.rows) {
        (itemsByOrder[row.order_id] || (itemsByOrder[row.order_id] = [])).push(
          row,
        );
      }
    }

    // Unpaid orders are listed at today's prices (display only - nothing is saved here).
    // The price actually charged is re-checked when the customer pays.
    let live = new Map();
    if (asksForUnpaid) {
      const unpaidIds = ordersResult.rows
        .filter((o) => ["awaiting", "failed"].includes(o.payment_status))
        .map((o) => o.id);
      live = await priceUnpaidOrders(env, unpaidIds).catch(() => new Map());
    }

    const orders = ordersResult.rows.map((order) => {
      const l = live.get(order.id);
      return {
        ...order,
        total_amount: l ? l.total : parseFloat(order.total_amount),
        ...(l
          ? { original_total: l.stored_total, price_changed: l.total !== l.stored_total, problems: l.problems }
          : {}),
        items: l ? l.items : itemsByOrder[order.id] || [],
      };
    });

    return jsonResponse({ orders, limit, offset });
  } catch (err) {
    return jsonResponse(
      { error: "Failed to load order history.", message: err.message },
      500,
    );
  }
}

export async function onRequestDelete(context) {
  const { request, env } = context;
  const authError = await requireAdmin(request, env);
  if (authError) return authError;

  try {
    // Dashboard "Pending Orders" manual clear: removes orders that were never paid (awaiting / failed)
    const url = new URL(request.url);
    if (url.searchParams.get("scope") === "unpaid") {
      const id = parseInt(url.searchParams.get("id"), 10);
      const result = Number.isInteger(id)
        ? await runQuery(
            env,
            `DELETE FROM orders WHERE id = $1 AND payment_status IN ('awaiting', 'failed') RETURNING id;`,
            [id],
          )
        : await runQuery(
            env,
            `DELETE FROM orders WHERE payment_status IN ('awaiting', 'failed') RETURNING id;`,
          );
      return jsonResponse({ success: true, deleted_count: result.rows.length });
    }

    const result = await runQuery(
      env,
      `
      DELETE FROM orders WHERE status IN ('Completed', 'Cancelled') RETURNING id;
    `,
    );
    return jsonResponse({ success: true, deleted_count: result.rows.length });
  } catch (err) {
    return jsonResponse(
      { error: "Failed to clear order history.", message: err.message },
      500,
    );
  }
}
