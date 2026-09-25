/**
 * functions/api/admin/orders.js
 * -----------------------------------------------------------------------
 * GET /api/admin/orders
 * Full order history (every status - New, Preparing, Ready, Collection, Delivery, Completed,
 * Cancelled), for the admin "History" tab. Distinct from
 * /api/admin/pending-orders, which only ever shows the live kitchen queue.
 *
 * Query params (all optional):
 *   status         - "New" | "Preparing" | "Ready" | "Collection" | "Delivery" | "Completed" | "Cancelled"
 *   payment_status - "paid" | "awaiting" | "failed" | "not_required" (e.g. combined
 *                     with status=Cancelled, this is how the admin "Refund Needed"
 *                     history filter finds cancelled orders that were already paid)
 *   search         - matches customer name, phone, or exact order id
 *   limit          - default 30, max 100
 *   offset         - default 0 (for "Load more" pagination)
 *
 * DELETE /api/admin/orders
 * "Clear History" - permanently removes every Completed and Cancelled
 * order (and their order_items, via ON DELETE CASCADE). Live orders
 * still in New, Preparing, Ready, Collection, or Delivery are never touched by this, so an
 * admin can't accidentally wipe an order the kitchen hasn't finished
 * yet. Note this also reduces the counts shown on the Your Sales tab,
 * since those are computed live from the same orders table.
 * -----------------------------------------------------------------------
 */
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { requireAdmin } from "../../_lib/auth.js";
import { ensureCancelledByColumn } from "../../_lib/orderCancel.js";

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
    // Order History never lists unpaid orders (payment still awaiting, or
    // failed) - they were never really placed as far as the cafe is
    // concerned. Cancelled-after-payment orders are still shown. The only
    // way to see unpaid orders is to ask for them explicitly with
    // payment_status=awaiting|failed (used by the dashboard's "Pending
    // Orders" card, never by the History tab).
    const asksForUnpaid = paymentStatus === "awaiting" || paymentStatus === "failed";
    const conditions = asksForUnpaid
      ? []
      : [`payment_status NOT IN ('awaiting', 'failed')`];
    const params = [];

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
      ["paid", "awaiting", "failed", "not_required", "refunded"].includes(paymentStatus)
    ) {
      params.push(paymentStatus);
      conditions.push(`payment_status = $${params.length}`);
    }
    if (refundFilter === "true" || refundFilter === "false") {
      params.push(refundFilter === "true");
      conditions.push(`refund_needed = $${params.length}`);
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
    const ordersResult = await runQuery(
      env,
      `
      SELECT id, customer_name, customer_phone, order_type, delivery_address, table_number,
             pickup_time, special_instructions, total_amount,
             CASE WHEN status = 'Out for Delivery' THEN 'Delivery' ELSE status END AS status,
             payment_method, payment_status, payment_ref, refund_needed, refund_processed_at, refund_ref, refund_error, cancelled_by, created_at
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

    const orders = ordersResult.rows.map((order) => ({
      ...order,
      total_amount: parseFloat(order.total_amount),
      items: itemsByOrder[order.id] || [],
    }));

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
    // Dashboard "Pending Orders" manual clear: removes orders that were
    // never paid (awaiting / failed) - either one specific order (?id=) or
    // all of them. Paid orders are never touched by this.
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
