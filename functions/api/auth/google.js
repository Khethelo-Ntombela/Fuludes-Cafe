/**
 * functions/api/auth/google.js
 * -----------------------------------------------------------------------
 * POST /api/auth/google  { id_token }
 * Exchanges a Google ID token issued by the client for a local session.
 * The server verifies the token with Google's tokeninfo endpoint and
 * upserts a `customers` row with `google_id` and `is_verified = TRUE`.
 * Google accounts never get a stored password_hash/salt per FR07.
 * -----------------------------------------------------------------------
 */
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { generateToken } from "../../_lib/password.js";
import { ensureCustomerProfileColumns } from "../../_lib/customerAuth.js";

export async function onRequestPost(context) {
  const { request, env } = context;
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body.' }, 400);
  }

  const idToken = body.id_token;
  if (!idToken) return jsonResponse({ error: 'Missing id_token.' }, 400);

  try {
    // Verify token with Google's tokeninfo endpoint
    const verifyRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
    if (!verifyRes.ok) return jsonResponse({ error: 'Invalid Google ID token.' }, 401);
    const payload = await verifyRes.json();

    // audience must match our configured client id
    if (env.GOOGLE_CLIENT_ID && payload.aud !== env.GOOGLE_CLIENT_ID) {
      return jsonResponse({ error: 'Token audience mismatch.' }, 401);
    }

    const email = (payload.email || '').toLowerCase();
    const name = payload.name || '';
    const googleId = payload.sub;

    if (!email || !googleId) return jsonResponse({ error: 'Google token missing required fields.' }, 400);

    await ensureCustomerProfileColumns(env);

    // Upsert: if a customer with this email exists, attach google_id and mark verified.
    // Otherwise insert a new customer row without a password.
    const existing = await runQuery(env, 'SELECT id FROM customers WHERE email = $1;', [email]);
    let customerId;
    if (existing.rows[0]) {
      customerId = existing.rows[0].id;
      await runQuery(env, "UPDATE customers SET google_id = $1, is_verified = TRUE, name = COALESCE(NULLIF($2, ''), name) WHERE id = $3;", [googleId, name, customerId]);
    } else {
      const insert = await runQuery(env, 'INSERT INTO customers (name, email, google_id, is_verified) VALUES ($1, $2, $3, TRUE) RETURNING id, name, email, phone_number, delivery_address;', [name, email, googleId]);
      customerId = insert.rows[0].id;
    }

    // Create session
    const token = generateToken();
    await runQuery(env, 'INSERT INTO customer_sessions (token, customer_id) VALUES ($1, $2);', [token, customerId]);

    // Fetch customer profile to return to client (so the client can update UI immediately)
    const custRes = await runQuery(env, 'SELECT id, name, email, phone_number, delivery_address FROM customers WHERE id = $1;', [customerId]);
    const customer = custRes.rows[0] || null;

    // Google sign-in not written to audit_logs (audit reserved for admin/staff actions)

    return jsonResponse({ success: true, token, customer });
  } catch (err) {
    return jsonResponse({ error: 'Google sign-in failed.', message: err.message }, 500);
  }
}
