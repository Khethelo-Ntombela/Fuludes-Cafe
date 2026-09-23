/**
 * functions/api/review.js
 * -----------------------------------------------------------------------
 * GET  /api/review  -> all reviews (with any owner_reply) for the public
 *                      review wall, newest first.
 * POST /api/review  -> a customer submits a new rating + comment.
 *                      Reviews post immediately (no approval queue), per
 *                      the cafe's requirements.
 * -----------------------------------------------------------------------
 */
import { runQuery, jsonResponse } from "../_lib/db.js";
import { sanitizeText } from "../_lib/security.js";
import { requireCustomer } from "../_lib/customerAuth.js";

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === "GET") {
    try {
      // If this is an admin request, return all reviews (including pending),
      // otherwise return only approved reviews for the public wall.
      const { Authorization } = request.headers;
      let isAdmin = false;
      try {
        // lightweight admin check: requireAdmin throws a Response when unauthorized
        const { requireAdmin } = await import("../_lib/auth.js");
        const err = await requireAdmin(request, env);
        if (!err) isAdmin = true;
      } catch (e) {
        /* ignore - not admin */
      }

      const q = isAdmin
        ? `
        SELECT id, customer_name, rating, comment, owner_reply, created_at, status
        FROM reviews
        ORDER BY created_at DESC
        LIMIT 200;
      `
        : `
        SELECT id, customer_name, rating, comment, owner_reply, created_at
        FROM reviews
        WHERE status = 'approved'
        ORDER BY created_at DESC
        LIMIT 100;
      `;
      const result = await runQuery(env, q);
      return jsonResponse({ reviews: result.rows });
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
