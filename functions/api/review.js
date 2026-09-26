/**
 * functions/api/review.js
 * -----------------------------------------------------------------------
 * GET  /api/review  -> approved reviews (with any owner_reply) for the
 *                      public review wall, newest first, each with the food
 *                      that order contained (drinks left out).
 * POST /api/review  -> a customer submits a rating + comment, optionally
 *                      for one specific paid order (one review per order).
 *                      New reviews wait for admin approval
 *                      (admin > Reviews, via /api/admin/reviews).
 * -----------------------------------------------------------------------
 */
import { runQuery, jsonResponse } from "../_lib/db.js";
import { sanitizeText } from "../_lib/security.js";
import { requireCustomer } from "../_lib/customerAuth.js";
import { reviewItemsByOrder } from "../_lib/reviewItems.js";

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === "GET") {
    try {
      // Public wall: approved reviews only. (Admins see every review,
      // including pending ones, through /api/admin/reviews.)
      const result = await runQuery(
        env,
        `
        SELECT id, customer_name, rating, comment, owner_reply, created_at, order_id
        FROM reviews
        WHERE status = 'approved'
        ORDER BY created_at DESC
        LIMIT 100;
      `,
      );
      const items = await reviewItemsByOrder(env, result.rows.map((r) => r.order_id)).catch(() => ({}));
      return jsonResponse({
        reviews: result.rows.map(({ order_id, ...r }) => ({ ...r, items: items[order_id] || [] })),
      });
    } catch (err) {
      return jsonResponse(
        { error: "Failed to load reviews.", message: err.message },
        500,
      );
    }
  }

  if (request.method === "POST") {
    try {
      const body = await request.json();
      const { customer, error } = await requireCustomer(request, env);
      if (error) return error;

      // Only customers who have actually bought something (a paid order)
      // may leave a review.
      const purchased = await runQuery(
        env,
        "SELECT 1 FROM orders WHERE customer_id = $1 AND payment_status = 'paid' LIMIT 1;",
        [customer.id],
      );
      if (!purchased.rows.length) {
        return jsonResponse(
          {
            error: "Sorry, you cannot leave a review yet.",
            code: "no_purchase",
          },
          403,
        );
      }

      const customerName = sanitizeText(body.customer_name || "", 100);
      const rating = parseInt(body.rating, 10);
      const comment = sanitizeText(body.comment || "", 1000);
      const orderId = body.order_id ? parseInt(body.order_id, 10) : null;

      if (
        !customerName ||
        !comment ||
        !Number.isInteger(rating) ||
        rating < 1 ||
        rating > 5
      ) {
        return jsonResponse(
          {
            error:
              "Please provide your name, a comment, and a rating from 1-5.",
          },
          400,
        );
      }

      if (orderId) {
        const order = await runQuery(
          env,
          "SELECT id FROM orders WHERE id = $1 AND customer_id = $2 AND payment_status = 'paid';",
          [orderId, customer.id],
        );
        if (!order.rows.length)
          return jsonResponse(
            { error: "You can only review your own paid orders." },
            400,
          );
        const already = await runQuery(env, "SELECT 1 FROM reviews WHERE order_id = $1 LIMIT 1;", [orderId]);
        if (already.rows.length)
          return jsonResponse({ error: "You've already reviewed this order - thank you!", code: "already_reviewed" }, 409);
      }

      const result = await runQuery(
        env,
        `
        INSERT INTO reviews (customer_id, order_id, customer_name, rating, comment, created_at, status)
        VALUES ($1, $2, $3, $4, $5, NOW(), 'pending')
        RETURNING id, customer_name, rating, comment, owner_reply, created_at, status;
      `,
        [customer.id, orderId, customerName, rating, comment],
      );

      // Review submitted into moderation queue
      return jsonResponse(
        {
          success: true,
          review: result.rows[0],
          message: "Your review has been submitted for moderation.",
        },
        201,
      );
    } catch (err) {
      return jsonResponse(
        { error: "Failed to submit review.", message: err.message },
        500,
      );
    }
  }

  return jsonResponse({ error: "Method not allowed. Use GET or POST." }, 405);
}
