// POST /api/auth/reset-password
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { hashPassword } from "../../_lib/password.js";
import { ensureLockoutColumns } from "../../_lib/accountLockout.js";

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

    // Not a customer token? It may be a main-admin reset link - those now
    // land on the same public sign-in site, so redeem them here too.
    if (!reset) {
      const adminReset = (
        await runQuery(
          env,
          `SELECT r.admin_id, r.expires_at, r.used, a.permissions, a.is_active
             FROM admin_password_resets r
             JOIN admin_accounts a ON a.id = r.admin_id
            WHERE r.token = $1;`,
          [token],
        ).catch(() => ({ rows: [] }))
      ).rows[0];
      if (adminReset) {
        if (adminReset.used || new Date(adminReset.expires_at) < new Date()) {
          return jsonResponse({ error: "This reset link is invalid or has expired. Please request a new one." }, 400);
        }
        if (!adminReset.is_active || !adminReset.permissions || !adminReset.permissions.all) {
          return jsonResponse({ error: "Please contact admin for assistance with password changes." }, 403);
        }
        await ensureLockoutColumns(env, "admin_accounts");
        const { hash, salt } = await hashPassword(newPassword);
        await runQuery(env, "UPDATE admin_accounts SET password_hash = $1, password_salt = $2, failed_login_attempts = 0, is_locked = FALSE, updated_at = NOW() WHERE id = $3;", [hash, salt, adminReset.admin_id]);
        await runQuery(env, "UPDATE admin_password_resets SET used = TRUE WHERE token = $1;", [token]);
        await runQuery(env, "DELETE FROM admin_sessions WHERE admin_id = $1;", [adminReset.admin_id]).catch(() => {});
        return jsonResponse({ success: true });
      }
    }

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
