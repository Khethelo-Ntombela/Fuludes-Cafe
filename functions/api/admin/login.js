/**
 * functions/api/admin/login.js
 * -----------------------------------------------------------------------
 * POST /api/admin/login  { email, password }
 * Checks the submitted email/password against the admin credentials in
 * the env file (ADMIN_EMAIL / ADMIN_PASSWORD), or against the hashed
 * admin account in Neon, then creates a database-backed session token.
 * -----------------------------------------------------------------------
 */
import { jsonResponse, runQuery } from "../../_lib/db.js";
import { sanitizeText } from "../../_lib/security.js";
import { generateToken, verifyPassword, hashPassword } from "../../_lib/password.js";
import { saveSession, isDbAvailable } from "../../_lib/sessionStore.js";

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed. Use POST." }, 405);
  }
  try {
    const { email, password } = await request.json().catch(() => ({}));
    const emailText = sanitizeText(email || "")
      .trim()
      .toLowerCase();
    const passwordText = sanitizeText(password);
    if (!passwordText) {
      return jsonResponse({ error: "Password is required." }, 400);
    }

    const envValid =
      emailText ===
        String(env.ADMIN_EMAIL || "")
          .trim()
          .toLowerCase() && passwordText === String(env.ADMIN_PASSWORD || "");

    if (envValid) {
      const token = generateToken();
      if (isDbAvailable(env)) {
        await runQuery(
          env,
          `CREATE TABLE IF NOT EXISTS admin_accounts (
          id SERIAL PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
          password_salt TEXT NOT NULL, permissions JSONB NOT NULL DEFAULT '{"all": true}',
          is_active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );`,
        );
        await runQuery(
          env,
          `ALTER TABLE admin_accounts ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '{"all": true}';`,
        );
        await runQuery(
          env,
          `CREATE TABLE IF NOT EXISTS admin_sessions (
          token TEXT PRIMARY KEY, admin_id INTEGER NOT NULL REFERENCES admin_accounts(id) ON DELETE CASCADE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '12 hours')
        );`,
        );
        let accountResult = await runQuery(
          env,
          "SELECT id, permissions FROM admin_accounts WHERE email = $1 AND is_active = TRUE LIMIT 1;",
          [emailText],
        );
        let account = accountResult.rows[0];
        if (!account) {
          const hashed = await hashPassword(passwordText);
          const insertResult = await runQuery(
            env,
            "INSERT INTO admin_accounts (email, password_hash, password_salt, permissions) VALUES ($1, $2, $3, '{\"all\": true}') RETURNING id, permissions;",
            [emailText, hashed.hash, hashed.salt],
          );
          account = insertResult.rows[0];
        }
        await runQuery(
          env,
          "INSERT INTO admin_sessions (token, admin_id) VALUES ($1, $2);",
          [token, account.id],
        );
        return jsonResponse({
          success: true,
          token,
          permissions: account.permissions || {},
        });
      } else {
        saveSession(token, "admin", 0, { all: true });
        return jsonResponse({
          success: true,
          token,
          permissions: { all: true },
        });
      }
    }

    if (isDbAvailable(env)) {
      await runQuery(
        env,
        `CREATE TABLE IF NOT EXISTS admin_accounts (
        id SERIAL PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL, permissions JSONB NOT NULL DEFAULT '{"all": true}',
        is_active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );`,
      );
      await runQuery(
        env,
        `ALTER TABLE admin_accounts ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '{"all": true}';`,
      );
      await runQuery(
        env,
        `CREATE TABLE IF NOT EXISTS admin_sessions (
        token TEXT PRIMARY KEY, admin_id INTEGER NOT NULL REFERENCES admin_accounts(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '12 hours')
      );`,
      );
      const accountResult = await runQuery(
        env,
        "SELECT id, password_hash, password_salt, permissions FROM admin_accounts WHERE email = $1 AND is_active = TRUE LIMIT 1;",
        [emailText],
      );
      const account = accountResult.rows[0];
      const valid = Boolean(
        account &&
        (await verifyPassword(
          passwordText,
          account.password_hash,
          account.password_salt,
        )),
      );
      if (!valid) {
        return jsonResponse({ error: "Incorrect password." }, 401);
      }
      const token = generateToken();
      await runQuery(
        env,
        "INSERT INTO admin_sessions (token, admin_id) VALUES ($1, $2);",
        [token, account.id],
      );
      return jsonResponse({
        success: true,
        token,
        permissions: account.permissions || {},
      });
    }

    return jsonResponse({ error: "Incorrect password." }, 401);
  } catch (err) {
    console.error("admin login error:", err);
    return jsonResponse(
      { error: "We couldn't sign you in right now. Please try again." },
      500,
    );
  }
}
