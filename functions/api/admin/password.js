/**
 * functions/api/admin/password.js
 * -----------------------------------------------------------------------
 * POST /api/admin/password  { current_password, new_password }
 * Lets the signed-in admin change their own password. This is separate
 * from the customer-style password reset flow, and is protected by the
 * existing admin bearer token.
 * ----------------------------------------------------------------------- */
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { requireAdmin } from "../../_lib/auth.js";
import { hashPassword, verifyPassword } from "../../_lib/password.js";
import { logAudit } from "../../_lib/audit.js";
import { getRequestIp, sanitizeText } from "../../_lib/security.js";

async function ensureAdminAccountTable(env) {
  await runQuery(
    env,
    `
    CREATE TABLE IF NOT EXISTS admin_accounts (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `,
  );
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed. Use POST." }, 405);
  }

  const authError = await requireAdmin(request, env);
  if (authError) return authError;

  const requestIp = getRequestIp(request);
  await ensureAdminAccountTable(env);
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body." }, 400);
  }

  const currentPassword = sanitizeText(body.current_password || "");
  const newPassword = sanitizeText(body.new_password || "");
  if (!currentPassword || !newPassword) {
    return jsonResponse(
      { error: "Current password and new password are required." },
      400,
    );
  }
  if (newPassword.length < 8) {
    return jsonResponse(
      { error: "New password must be at least 8 characters." },
      400,
    );
  }

  try {
    const result = await runQuery(
      env,
      "SELECT id, password_hash, password_salt FROM admin_accounts WHERE is_active = TRUE ORDER BY id LIMIT 1;",
    );
    const account = result.rows[0];

    let isValid = false;
    if (account) {
      isValid = await verifyPassword(
        currentPassword,
        account.password_hash,
        account.password_salt,
      );
    }

    if (!isValid) {
      return jsonResponse({ error: "Current password is incorrect." }, 401);
    }

    const { hash, salt } = await hashPassword(newPassword);
    if (account) {
      await runQuery(
        env,
        "UPDATE admin_accounts SET password_hash = $1, password_salt = $2, updated_at = NOW() WHERE id = $3;",
        [hash, salt, account.id],
      );
    }

    await logAudit(env, {
      actor_type: "admin",
      actor_role: "admin",
      actor_ip: requestIp,
      action: "admin_password_changed",
    });

    return jsonResponse({ success: true });
  } catch (err) {
    return jsonResponse(
      { error: "Failed to update password.", message: err.message },
      500,
    );
  }
}
