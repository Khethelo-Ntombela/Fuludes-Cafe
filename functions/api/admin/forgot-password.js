/**
 * functions/api/admin/forgot-password.js
 * -----------------------------------------------------------------------
 * POST /api/admin/forgot-password  { email }
 * Emails a one-time reset link to an admin account.
 * ----------------------------------------------------------------------- */
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { generateToken } from "../../_lib/password.js";
import { sendEmail } from "../../_lib/email.js";
import { checkRateLimit } from "../../_lib/rateLimit.js";
import { logAudit } from "../../_lib/audit.js";
import { getRequestIp, sanitizeText } from "../../_lib/security.js";

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

async function ensureAdminTables(env) {
  await runQuery(env, `
    CREATE TABLE IF NOT EXISTS admin_accounts (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await runQuery(env, `
    CREATE TABLE IF NOT EXISTS admin_password_resets (
      token TEXT PRIMARY KEY,
      admin_id INTEGER NOT NULL REFERENCES admin_accounts(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      used BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed. Use POST." }, 405);
  }

  const requestIp = getRequestIp(request);
  if (!(await checkRateLimit(env, `admin-forgot:${requestIp}`, 5, 60))) {
    return jsonResponse({ error: "Too many password reset requests. Please wait a moment before trying again." }, 429);
  }

  await ensureAdminTables(env);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body." }, 400);
  }

  const email = sanitizeText(body.email || "").trim().toLowerCase();
  if (!email) {
    return jsonResponse({ error: "Email is required." }, 400);
  }

  const genericSuccess = () => jsonResponse({ success: true, message: "If that email has an admin account, a reset link is on its way." });

  try {
    const result = await runQuery(env, "SELECT id, email, permissions FROM admin_accounts WHERE email = $1 AND is_active = TRUE LIMIT 1;", [email]);
    const account = result.rows[0];
    // Only the main admin (full access) can reset their own password by
    // email. Helper admins have to ask the main admin instead.
    if (account && !(account.permissions && account.permissions.all)) {
      return jsonResponse(
        { error: "Password reset by email isn't available for this account. Please contact the main admin to reset your password.", contact_admin: true },
        403,
      );
    }
    if (!account) {
      return genericSuccess();
    }

    const token = generateToken();
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
    await runQuery(env, "INSERT INTO admin_password_resets (token, admin_id, expires_at) VALUES ($1, $2, $3);", [token, account.id, expiresAt]);

    await logAudit(env, {
      actor_type: "admin",
      actor_id: account.id,
      actor_role: "password_reset_request",
      actor_ip: requestIp,
      action: "admin_forgot_password",
      target_type: "admin",
      target_id: account.id
    });

    const origin = new URL(request.url).origin;
    const resetLink = `${origin}/admin.html?reset_token=${token}`;
    await sendEmail(env, {
      to: email,
      subject: "Reset your Fulude's Cafe admin password",
      html: `<p>Hi ${email},</p><p>Someone (hopefully you) asked to reset the admin password on Fulude's Cafe. This link is valid for 1 hour.</p><p><a href="${resetLink}">${resetLink}</a></p><p>If you didn't request this, you can safely ignore this email.</p>`
    });

    return genericSuccess();
  } catch (err) {
    return jsonResponse({ error: "Couldn't process this request right now. Please try again shortly.", message: err.message }, 500);
  }
}
