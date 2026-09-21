/**
 * functions/api/auth/reset-password.js
 * -----------------------------------------------------------------------
 * POST /api/auth/reset-password  { token, password }
 * Redeems a one-time token from forgot-password.js, sets a new password,
 * clears the 4-failed-attempt lockout (functions/api/auth/login.js), and
 * signs the account out everywhere by deleting every one of its sessions -
 * a password reset should invalidate any session an attacker might have
 * had, not just fix the password going forward.
 * -----------------------------------------------------------------------
 */
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { hashPassword } from "../../_lib/password.js";

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body." }, 400);
  }

  const token = (body.token || "").trim();
  const newPassword = body.password || "";
  if (!token || !newPassword) {
    return jsonResponse({ error: "A reset token and new password are required." }, 400);
  }
  if (newPassword.length < 8) {
    return jsonResponse({ error: "Password must be at least 8 characters." }, 400);
  }

  try {
    const result = await runQuery(env, "SELECT id, customer_id, expires_at, used FROM password_resets WHERE token = $1;", [token]);
    const reset = result.rows[0];

    if (!reset || reset.used || new Date(reset.expires_at) < new Date()) {
      return jsonResponse({ error: "This reset link is invalid or has expired. Please request a new one." }, 400);
    }

    const { hash, salt } = await hashPassword(newPassword);
    await runQuery(env, `
      UPDATE customers SET password_hash = $1, password_salt = $2, failed_login_attempts = 0, is_locked = FALSE
      WHERE id = $3;
    `, [hash, salt, reset.customer_id]);

    await runQuery(env, "UPDATE password_resets SET used = TRUE WHERE id = $1;", [reset.id]);
    await runQuery(env, "DELETE FROM customer_sessions WHERE customer_id = $1;", [reset.customer_id]);

    return jsonResponse({ success: true });
  } catch (err) {
    return jsonResponse({ error: "Failed to reset password.", message: err.message }, 500);
  }
}
