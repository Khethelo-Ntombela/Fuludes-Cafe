/**
 * functions/api/admin/reset-password.js
 * -----------------------------------------------------------------------
 * POST /api/admin/reset-password  { token, password }
 * Redeems an admin password reset token.
 * ----------------------------------------------------------------------- */
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { hashPassword } from "../../_lib/password.js";
import { ensureLockoutColumns } from "../../_lib/accountLockout.js";

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed. Use POST." }, 405);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body." }, 400);
  }

  const token = (body.token || "").trim();
  const newPassword = (body.password || "").trim();
  if (!token || !newPassword) {
    return jsonResponse({ error: "A reset token and new password are required." }, 400);
  }
  if (newPassword.length < 8) {
    return jsonResponse({ error: "Password must be at least 8 characters." }, 400);
  }

  try {
    const result = await runQuery(
      env,
      `SELECT r.admin_id, r.expires_at, r.used, a.permissions, a.is_active
       FROM admin_password_resets r
       JOIN admin_accounts a ON a.id = r.admin_id
       WHERE r.token = $1;`,
      [token],
    );
    const reset = result.rows[0];

    if (!reset || reset.used || new Date(reset.expires_at) < new Date()) {
      return jsonResponse({ error: "This reset link is invalid or has expired. Please request a new one." }, 400);
    }
    if (!reset.is_active || !reset.permissions || !reset.permissions.all) {
      return jsonResponse(
        { error: "Please contact admin for assistance with password changes." },
        403,
      );
    }

    await ensureLockoutColumns(env, "admin_accounts");
    const { hash, salt } = await hashPassword(newPassword);
    await runQuery(env, "UPDATE admin_accounts SET password_hash = $1, password_salt = $2, failed_login_attempts = 0, is_locked = FALSE, updated_at = NOW() WHERE id = $3;", [hash, salt, reset.admin_id]);
    await runQuery(env, "UPDATE admin_password_resets SET used = TRUE WHERE token = $1;", [token]);

    return jsonResponse({ success: true });
  } catch (err) {
    return jsonResponse({ error: "Failed to reset password.", message: err.message }, 500);
  }
}
