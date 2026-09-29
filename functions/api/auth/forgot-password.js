/**
 * functions/api/auth/forgot-password.js
 * -----------------------------------------------------------------------
 * POST /api/auth/forgot-password  { email }
 * Sends password reset links to customers and the main admin. Added admins
 * and staff are directed to contact the admin; other addresses get a
 * generic response to limit account enumeration.
 *
 * The link points at `/?reset_token=<token>` - public/js/main.js checks
 * for that query param on page load and opens the reset-password form
 * instead of the sign-in form.
 * -----------------------------------------------------------------------
 */
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { generateToken, hashPassword } from "../../_lib/password.js";
import { sendEmail } from "../../_lib/email.js";
import { checkRateLimit } from "../../_lib/rateLimit.js";
import { getRequestIp, sanitizeText } from "../../_lib/security.js";
import { logAudit } from "../../_lib/audit.js";

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

  const email = sanitizeText(body.email || "").trim().toLowerCase();
  if (!email) {
    return jsonResponse({ error: "Email is required." }, 400);
  }

  const genericSuccess = () => jsonResponse({ success: true, message: "If that email has an account, a reset link is on its way." });

  try {
    const configuredStaffEmail = String(env.STAFF_EMAIL || "").trim().toLowerCase();
    if (configuredStaffEmail && email === configuredStaffEmail) {
      return jsonResponse(
        { error: "Please contact admin for assistance with password changes." },
        403,
      );
    }

    const staffResult = await runQuery(
      env,
      "SELECT id FROM staff_accounts WHERE LOWER(email) = $1 AND is_active = TRUE LIMIT 1;",
      [email],
    ).catch(() => ({ rows: [] }));
    const legacyStaffResult = await runQuery(
      env,
      "SELECT 1 FROM users WHERE LOWER(email) = $1 AND LOWER(role) = 'staff' LIMIT 1;",
      [email],
    ).catch(() => ({ rows: [] }));
    if (staffResult.rows[0] || legacyStaffResult.rows[0]) {
      return jsonResponse(
        { error: "Please contact admin for assistance with password changes." },
        403,
      );
    }

    const adminResult = await runQuery(
      env,
      "SELECT id, email, permissions FROM admin_accounts WHERE LOWER(email) = $1 AND is_active = TRUE LIMIT 1;",
      [email],
    ).catch(() => ({ rows: [] }));
    let adminAccount = adminResult.rows[0];
    const configuredAdminEmail = String(env.ADMIN_EMAIL || "").trim().toLowerCase();
    if (!adminAccount && configuredAdminEmail && email === configuredAdminEmail && env.ADMIN_PASSWORD) {
      await runQuery(env, `
        CREATE TABLE IF NOT EXISTS admin_accounts (
          id SERIAL PRIMARY KEY,
          email TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          password_salt TEXT NOT NULL,
          permissions JSONB NOT NULL DEFAULT '{"all": true}',
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          email_verified BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      const bootstrapPassword = await hashPassword(String(env.ADMIN_PASSWORD));
      await runQuery(
        env,
        `INSERT INTO admin_accounts (email, password_hash, password_salt, permissions, email_verified)
         VALUES ($1, $2, $3, '{"all": true}', TRUE)
         ON CONFLICT (email) DO NOTHING;`,
        [configuredAdminEmail, bootstrapPassword.hash, bootstrapPassword.salt],
      );
      const createdAdmin = await runQuery(
        env,
        "SELECT id, email, permissions FROM admin_accounts WHERE LOWER(email) = $1 AND is_active = TRUE LIMIT 1;",
        [email],
      );
      adminAccount = createdAdmin.rows[0];
    }
    if (adminAccount) {
      if (!adminAccount.permissions || !adminAccount.permissions.all) {
        return jsonResponse(
          { error: "Please contact admin for assistance with password changes." },
          403,
        );
      }
      await runQuery(env, `
        CREATE TABLE IF NOT EXISTS admin_password_resets (
          token TEXT PRIMARY KEY,
          admin_id INTEGER NOT NULL REFERENCES admin_accounts(id) ON DELETE CASCADE,
          expires_at TIMESTAMPTZ NOT NULL,
          used BOOLEAN NOT NULL DEFAULT FALSE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      const token = generateToken();
      const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
      await runQuery(
        env,
        "INSERT INTO admin_password_resets (token, admin_id, expires_at) VALUES ($1, $2, $3);",
        [token, adminAccount.id, expiresAt],
      );
      await logAudit(env, {
        actor_type: "admin",
        actor_id: adminAccount.id,
        actor_role: "password_reset_request",
        actor_ip: requestIp,
        action: "admin_forgot_password",
        target_type: "admin",
        target_id: adminAccount.id,
      });
      const origin = new URL(request.url).origin;
      const resetLink = `${origin}/fc-hq.html?reset_token=${token}`;
      await sendEmail(env, {
        to: adminAccount.email,
        subject: "Reset your Fulude's Cafe admin password",
        html: `<p>Hi ${adminAccount.email},</p><p>Someone (hopefully you) asked to reset the admin password on Fulude's Cafe. This link is valid for 1 hour.</p><p><a href="${resetLink}">${resetLink}</a></p><p>If you didn't request this, you can safely ignore this email.</p>`,
      });
      return genericSuccess();
    }

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
