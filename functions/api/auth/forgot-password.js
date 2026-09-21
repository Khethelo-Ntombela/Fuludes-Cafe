/**
 * functions/api/auth/forgot-password.js
 * -----------------------------------------------------------------------
 * POST /api/auth/forgot-password  { email }
 * Emails a one-time reset link (valid for RESET_TOKEN_TTL_MS) via Resend
 * (functions/_lib/email.js) if that email has an account. Always returns
 * the same generic success message either way - so this endpoint can't be
 * used to check who has an account on the site.
 *
 * The link points at `/?reset_token=<token>` - public/js/main.js checks
 * for that query param on page load and opens the reset-password form
 * instead of the sign-in form.
 * -----------------------------------------------------------------------
 */
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { generateToken } from "../../_lib/password.js";
import { sendEmail } from "../../_lib/email.js";
import { checkRateLimit } from "../../_lib/rateLimit.js";
import { getRequestIp, sanitizeText } from "../../_lib/security.js";

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

export async function onRequestPost(context) {
  const { request, env } = context;
  const requestIp = getRequestIp(request);
  if (!(await checkRateLimit(env, `auth-forgot:${requestIp}`, 5, 60))) {
    return jsonResponse({ error: "Too many password reset requests. Please wait a moment before trying again." }, 429);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body." }, 400);
  }

  const email = sanitizeText(body.email || "").toLowerCase();
  if (!email) {
    return jsonResponse({ error: "Email is required." }, 400);
  }

  const genericSuccess = () => jsonResponse({ success: true, message: "If that email has an account, a reset link is on its way." });

  try {
    const result = await runQuery(env, "SELECT id, name FROM customers WHERE email = $1;", [email]);
    const account = result.rows[0];
    if (!account) {
      return genericSuccess();
    }

    const token = generateToken();
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
    await runQuery(env, "INSERT INTO password_resets (token, customer_id, expires_at) VALUES ($1, $2, $3);", [token, account.id, expiresAt]);

    // Password reset request not written to audit_logs (audit reserved for admin/staff actions)

    const origin = new URL(request.url).origin;
    const resetLink = `${origin}/?reset_token=${token}`;

    await sendEmail(env, {
      to: email,
      subject: "Reset your Fulude's Cafe password",
      html: `<p>Hi ${account.name},</p><p>Someone (hopefully you) asked to reset the password on your Fulude's Cafe account. This link is valid for 1 hour.</p><p><a href="${resetLink}">${resetLink}</a></p><p>If you didn't request this, you can safely ignore this email, your password won't change.</p>`
    });

    return genericSuccess();
  } catch (err) {
    // Don't leak whether the failure was "no account" vs "email service
    // down" - but do return a 500 so the frontend can show a fallback
    // message rather than silently claiming success when nothing sent.
    return jsonResponse({ error: "Couldn't process this request right now. Please try again shortly.", message: err.message }, 500);
  }
}
