// POST /api/auth/google
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { generateToken } from "../../_lib/password.js";
import { ensureCustomerProfileColumns } from "../../_lib/customerAuth.js";

const NONCE_COOKIE = "g_oauth_nonce";

export async function onRequestPost(context) {
  const { request } = context;
  const contentType = request.headers.get("Content-Type") || "";
  if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
    return handleRedirectFlow(context);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body.' }, 400);
  }
  if (!body.id_token) return jsonResponse({ error: 'Missing id_token.' }, 400);

  const result = await signInWithGoogleToken(context.env, body.id_token, null);
  if (result.error) return jsonResponse({ error: result.error, message: result.message }, result.status);
  return jsonResponse({ success: true, token: result.token, customer: result.customer });
}

/** Google's form_post callback - always answers with a redirect back to the site. */
async function handleRedirectFlow(context) {
  const { request, env } = context;
  let form;
  try {
    form = await request.formData();
  } catch {
    form = new FormData();
  }
  const state = String(form.get("state") || "");
  const dot = state.indexOf(".");
  const nonce = dot > 0 ? state.slice(0, dot) : "";
  const returnPath = safeReturnPath(dot > 0 ? state.slice(dot + 1) : "");

  const back = (fragment) =>
    new Response(null, {
      status: 303,
      headers: {
        Location: `${returnPath}#${fragment}`,
        // one-time nonce - clear it whatever happened
        "Set-Cookie": `${NONCE_COOKIE}=; Path=/; Max-Age=0; Secure; SameSite=None`,
        "Cache-Control": "no-store",
      },
    });
  const fail = (message) => back(`google_error=${encodeURIComponent(message)}`);

  // Customer pressed "Cancel" on Google's page, or Google refused the request.
  if (form.get("error")) {
    return fail(form.get("error") === "access_denied" ? "Google sign-in was cancelled." : "Google sign-in failed. Please try again.");
  }

  const cookieNonce = readCookie(request.headers.get("Cookie"), NONCE_COOKIE);
  if (!nonce || !cookieNonce || cookieNonce !== nonce) {
    return fail("Google sign-in expired. Please try again.");
  }

  const idToken = String(form.get("id_token") || "");
  if (!idToken) return fail("Google sign-in failed. Please try again.");

  const result = await signInWithGoogleToken(env, idToken, nonce);
  if (result.error) {
    return fail(result.status >= 500 ? "Google sign-in failed. Please try again." : result.message || result.error);
  }
  return back(`google_token=${encodeURIComponent(result.token)}`);
}

// Verifies a Google ID token and returns { token, customer } for a new local session, or { error
async function signInWithGoogleToken(env, idToken, expectedNonce) {
  try {
    // Verify token with Google's tokeninfo endpoint
    const verifyRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
    if (!verifyRes.ok) return { error: 'Invalid Google ID token.', status: 401 };
    const payload = await verifyRes.json();

    // GOOGLE_CLIENT_ID must be configured server-side, or any Google ID token
    // from ANY app (not just this one) would be accepted. Treat as required.
    if (!env.GOOGLE_CLIENT_ID) {
      return { error: 'Google sign-in is not configured.', status: 500 };
    }
    if (payload.aud !== env.GOOGLE_CLIENT_ID) {
      return { error: 'Token audience mismatch.', status: 401 };
    }
    if (expectedNonce !== null && payload.nonce !== expectedNonce) {
      return { error: 'Google sign-in expired. Please try again.', status: 401 };
    }

    const email = (payload.email || '').toLowerCase();
    const name = payload.name || '';
    const googleId = payload.sub;

    if (!email || !googleId) return { error: 'Google token missing required fields.', status: 400 };

    await ensureCustomerProfileColumns(env);

    // Upsert: if a customer with this email exists, attach google_id and mark verified.
    // Otherwise insert a new customer row without a password.
    const existing = await runQuery(env, 'SELECT id, password_hash, google_id FROM customers WHERE email = $1;', [email]);
    let customerId;
    if (existing.rows[0]) {
      const row = existing.rows[0];
      // If this email already has a password-based account that has never been linked to Google before
      if (row.password_hash && !row.google_id) {
        return {
          error: 'account_exists_use_password',
          message: 'An account with this email already exists. Please sign in with your password instead.',
          status: 409,
        };
      }
      customerId = row.id;
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

    return { token, customer };
  } catch (err) {
    return { error: 'Google sign-in failed.', message: err.message, status: 500 };
  }
}

/** Only same-site paths like "/menu" - never "//evil.com" or "https://...". */
function safeReturnPath(path) {
  let decoded = "";
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return "/home";
  }
  if (!decoded.startsWith("/") || decoded.startsWith("//") || decoded.includes("\\") || decoded.includes("#")) {
    return "/home";
  }
  return decoded;
}

function readCookie(header, name) {
  if (!header) return "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return "";
}
