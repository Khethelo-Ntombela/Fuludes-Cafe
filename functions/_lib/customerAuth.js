/**
 * functions/_lib/customerAuth.js
 * -----------------------------------------------------------------------
 * Session lookup for logged-in customers - a different shape from the
 * admin/staff shared-secret pattern in auth.js. There isn't one password
 * for the whole role here; every customer has their own row in
 * `customers`, and a session is a random token stored in
 * `customer_sessions`, checked against Neon on every authenticated
 * request (place order, cancel order, view order history, log out).
 *
 * There's no expiry baked into a session - "stay signed in until you sign
 * out" - a session only ends when the customer logs out (which deletes
 * the row) or resets their password (which deletes every session for
 * that account, functions/api/auth/reset-password.js).
 * -----------------------------------------------------------------------
 */
import { runQuery, jsonResponse } from "./db.js";

/**
 * Returns { customer } on success, or { error: Response } to return
 * immediately if the request isn't authenticated. Usage:
 *   const { customer, error } = await requireCustomer(request, env);
 *   if (error) return error;
 */
export async function ensureCustomerProfileColumns(env) {
  await runQuery(
    env,
    `ALTER TABLE customers ADD COLUMN IF NOT EXISTS phone_number TEXT;`,
  );
  await runQuery(
    env,
    `ALTER TABLE customers ADD COLUMN IF NOT EXISTS delivery_address TEXT;`,
  );
  await runQuery(
    env,
    `ALTER TABLE customers ADD COLUMN IF NOT EXISTS marketing_email_opt_in BOOLEAN NOT NULL DEFAULT FALSE;`,
  );
  await runQuery(
    env,
    `ALTER TABLE customers ADD COLUMN IF NOT EXISTS google_id TEXT;`,
  );
  await runQuery(
    env,
    `ALTER TABLE customers ADD COLUMN IF NOT EXISTS is_verified BOOLEAN NOT NULL DEFAULT FALSE;`,
  );
}

export async function requireCustomer(request, env) {
  await ensureCustomerProfileColumns(env);

  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (!token) {
    return {
      error: jsonResponse({ error: "Please sign in to continue." }, 401),
    };
  }

  const result = await runQuery(
    env,
    `
        SELECT c.id, c.name, c.email, c.phone_number, c.delivery_address, c.google_id, c.is_verified,
          c.marketing_email_opt_in,
          (c.password_hash IS NOT NULL) AS has_password
    FROM customer_sessions s
    JOIN customers c ON c.id = s.customer_id
    WHERE s.token = $1 AND s.expires_at > NOW();
  `,
    [token],
  );

  const customer = result.rows[0];
  if (!customer) {
    return {
      error: jsonResponse(
        { error: "Your session has expired. Please sign in again." },
        401,
      ),
    };
  }

  return { customer };
}
