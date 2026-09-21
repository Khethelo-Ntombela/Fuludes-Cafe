/**
 * functions/api/auth/signup.js
 * -----------------------------------------------------------------------
 * POST /api/auth/signup  { name, email, password }
 * Creates a customer account (required to check out - see
 * functions/api/order.js) and immediately signs them in, returning a
 * session token the same way login.js does.
 * -----------------------------------------------------------------------
 */
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { hashPassword, generateToken } from "../../_lib/password.js";
import { sendEmail } from "../../_lib/email.js";
import { checkRateLimit } from "../../_lib/rateLimit.js";
import { getRequestIp, sanitizeText } from "../../_lib/security.js";
import { ensureCustomerProfileColumns } from "../../_lib/customerAuth.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function onRequestPost(context) {
  const { request, env } = context;
  const requestIp = getRequestIp(request);
  if (!(await checkRateLimit(env, `auth-signup:${requestIp}`, 5, 60))) {
    return jsonResponse(
      {
        error:
          "Too many account creation attempts. Please wait a moment before trying again.",
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

  const name = sanitizeText(body.name || "");
  const email = sanitizeText(body.email || "").toLowerCase();
  const password = body.password || "";

  if (!name || !email || !password) {
    return jsonResponse(
      { error: "Name, email, and password are all required." },
      400,
    );
  }
  if (!EMAIL_RE.test(email)) {
    return jsonResponse({ error: "Please enter a valid email address." }, 400);
  }
  if (password.length < 8) {
    return jsonResponse(
      { error: "Password must be at least 8 characters." },
      400,
    );
  }

  try {
    await runQuery(
      env,
      `
      CREATE TABLE IF NOT EXISTS email_verification_tokens (
        token TEXT PRIMARY KEY,
        customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL,
        used BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `,
    );
    const existing = await runQuery(
      env,
      "SELECT id FROM customers WHERE email = $1;",
      [email],
    );
    if (existing.rows.length > 0) {
      return jsonResponse(
        {
          error:
            "An account with this email already exists. Try signing in instead.",
        },
        409,
      );
    }

    await ensureCustomerProfileColumns(env);

    const { hash, salt } = await hashPassword(password);
    const insertResult = await runQuery(
      env,
      `
      INSERT INTO customers (name, email, password_hash, password_salt)
      VALUES ($1, $2, $3, $4) RETURNING id, name, email, phone_number, delivery_address;
    `,
      [name, email, hash, salt],
    );

    const customer = insertResult.rows[0];
    const token = generateToken();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await runQuery(
      env,
      "INSERT INTO email_verification_tokens (token, customer_id, expires_at) VALUES ($1, $2, $3);",
      [token, customer.id, expiresAt],
    );

    const verificationLink = `${new URL(request.url).origin}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
    await sendEmail(env, {
      to: email,
      subject: "Verify your Fulude's Cafe account",
      html: `<p>Hi ${name},</p><p>Please verify your email address to activate your account:</p><p><a href="${verificationLink}">${verificationLink}</a></p><p>This link expires in 24 hours.</p>`,
    });

    return jsonResponse({
      success: true,
      pending_verification: true,
      message:
        "Account created. Check your email to verify your account before signing in.",
      customer,
    });
  } catch (err) {
    return jsonResponse(
      { error: "Failed to create account.", message: err.message },
      500,
    );
  }
}
