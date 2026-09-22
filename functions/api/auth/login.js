/**
 * functions/api/auth/login.js
 * -----------------------------------------------------------------------
 * POST /api/auth/login  { email, password }
 * Signs an existing customer in and returns a session token (see
 * functions/_lib/customerAuth.js for how that token is later checked).
 *
 * Lockout: after MAX_FAILED_ATTEMPTS wrong passwords in a row, the
 * account is locked (`customers.is_locked = TRUE`) - further login
 * attempts are refused, even with the correct password, until the
 * customer resets their password (functions/api/auth/reset-password.js,
 * which clears both is_locked and the counter). A successful login at any
 * point before that resets the counter back to 0.
 * -----------------------------------------------------------------------
 */
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { verifyPassword, generateToken } from "../../_lib/password.js";
import { checkRateLimit } from "../../_lib/rateLimit.js";
import { getRequestIp, sanitizeText } from "../../_lib/security.js";
import { ensureCustomerProfileColumns } from "../../_lib/customerAuth.js";

const MAX_FAILED_ATTEMPTS = 4;

export async function onRequestPost(context) {
  const { request, env } = context;
  const requestIp = getRequestIp(request);

  if (!(await checkRateLimit(env, `auth-login:${requestIp}`, 10, 60))) {
    return jsonResponse(
      {
        error:
          "Too many login attempts. Please wait a moment before trying again.",
      },
      429,
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body." }, 400);
  }

  const email = sanitizeText(body.email || "").toLowerCase();
  const password = body.password || "";
  if (!email || !password) {
    return jsonResponse({ error: "Email and password are required." }, 400);
  }

  // Deliberately identical wording for "no such account" and "wrong
  // password" so a login attempt can't be used to discover which emails
  // are registered.
  const wrongCredentials = () =>
    jsonResponse({ error: "Incorrect email or password." }, 401);

  try {
    await ensureCustomerProfileColumns(env);

    const result = await runQuery(
      env,
      `
      SELECT id, name, email, phone_number, delivery_address, password_hash, password_salt, failed_login_attempts, is_locked, is_verified
      FROM customers WHERE email = $1;
    `,
      [email],
    );
    const account = result.rows[0];

    if (!account) {
      return wrongCredentials();
    }

    if (account.is_locked) {
      return jsonResponse(
        {
          error:
            "This account is locked after too many failed attempts. Please reset your password to sign in again.",
          locked: true,
        },
        423,
      );
    }

    if (!account.is_verified) {
      return jsonResponse(
        {
          error: "Please verify your email address before signing in.",
          needs_verification: true,
        },
        403,
      );
    }

    // If this account was created via Google OAuth it may not have a
    // password_hash/password_salt - treat password login attempts as
    // wrong credentials in that case to avoid leaking which emails exist.
    let isValid = false;
    if (account.password_hash && account.password_salt) {
      isValid = await verifyPassword(
        password,
        account.password_hash,
        account.password_salt,
      );
    }
    if (!isValid) {
      const attempts = account.failed_login_attempts + 1;
      const shouldLock = attempts >= MAX_FAILED_ATTEMPTS;
      await runQuery(
        env,
        "UPDATE customers SET failed_login_attempts = $1, is_locked = $2 WHERE id = $3;",
        [attempts, shouldLock, account.id],
      );

      // failed login recorded via failed_login_attempts counter; no audit log for customer events

      if (shouldLock) {
        return jsonResponse(
          {
            error:
              "This account is now locked after 4 failed attempts. Please reset your password to sign in again.",
            locked: true,
          },
          423,
        );
      }
      return wrongCredentials();
    }

    await runQuery(
      env,
      "UPDATE customers SET failed_login_attempts = 0 WHERE id = $1;",
      [account.id],
    );

    const token = generateToken();
    await runQuery(
      env,
      "INSERT INTO customer_sessions (token, customer_id) VALUES ($1, $2);",
      [token, account.id],
    );

    // Successful login not written to audit_logs (audit reserved for admin/staff actions)

    return jsonResponse({
      success: true,
      token,
      customer: {
        id: account.id,
        name: account.name,
        email: account.email,
        phone_number: account.phone_number,
        delivery_address: account.delivery_address,
      },
    });
  } catch (err) {
    return jsonResponse(
      { error: "Failed to sign in.", message: err.message },
      500,
    );
  }
}
