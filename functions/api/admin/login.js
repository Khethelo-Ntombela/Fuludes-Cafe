// POST /api/admin/login
import { jsonResponse, runQuery } from "../../_lib/db.js";
import { sanitizeText } from "../../_lib/security.js";
import { generateToken, verifyPassword, hashPassword } from "../../_lib/password.js";
import { saveSession, isDbAvailable } from "../../_lib/sessionStore.js";
import { ensureLockoutColumns, recordFailedLogin, clearFailedLogins, LOCKED_MESSAGE } from "../../_lib/accountLockout.js";

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
    if (!emailText || !passwordText) {
      return jsonResponse({ error: "Email and password are required." }, 400);
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
        await ensureLockoutColumns(env, "admin_accounts");
        let accountResult = await runQuery(
          env,
          "SELECT id, permissions, password_hash, password_salt FROM admin_accounts WHERE email = $1 AND is_active = TRUE LIMIT 1;",
          [emailText],
        );
        let account = accountResult.rows[0];
        if (!account) {
          const hashed = await hashPassword(passwordText);
          const insertResult = await runQuery(
            env,
            "INSERT INTO admin_accounts (email, password_hash, password_salt, permissions, email_verified) VALUES ($1, $2, $3, '{\"all\": true}', TRUE) RETURNING id, permissions;",
            [emailText, hashed.hash, hashed.salt],
          );
          account = insertResult.rows[0];
        } else {
          if (!(await verifyPassword(passwordText, account.password_hash, account.password_salt))) {
            return jsonResponse({ error: "Incorrect email or password." }, 401);
          }
          // The bootstrap admin is always trusted/verified and never locked out.
          await runQuery(env, "UPDATE admin_accounts SET email_verified = TRUE, is_locked = FALSE, failed_login_attempts = 0 WHERE id = $1;", [account.id]);
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
      await ensureLockoutColumns(env, "admin_accounts");

      const accountResult = await runQuery(
        env,
        "SELECT id, password_hash, password_salt, permissions, failed_login_attempts, is_locked, email_verified FROM admin_accounts WHERE email = $1 AND is_active = TRUE LIMIT 1;",
        [emailText],
      );
      const account = accountResult.rows[0];

      if (account) {
        if (account.is_locked) {
          return jsonResponse(
            { error: LOCKED_MESSAGE, locked: true },
            423,
          );
        }
        if (!account.email_verified) {
          return jsonResponse(
            { error: "Please verify your email address before signing in. Check your inbox for the verification link.", needs_verification: true },
            403,
          );
        }

        const valid = await verifyPassword(passwordText, account.password_hash, account.password_salt);
        if (valid) {
          await clearFailedLogins(env, "admin_accounts", account.id);
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

        const result = await recordFailedLogin(env, "admin_accounts", account.id, account.failed_login_attempts, "the main admin");
        return jsonResponse(result, result.locked ? 423 : 401);
      }

      let legacyAccount = null;
      try {
        const legacyResult = await runQuery(
          env,
          "SELECT email, password FROM users WHERE LOWER(email) = $1 AND LOWER(role) = 'admin' LIMIT 1;",
          [emailText],
        );
        legacyAccount = legacyResult.rows[0];
        if (legacyAccount && passwordText === String(legacyAccount.password || "")) {
          const migrated = await hashPassword(passwordText);
          const migratedResult = await runQuery(
            env,
            `INSERT INTO admin_accounts (email, password_hash, password_salt, permissions, email_verified)
             VALUES ($1, $2, $3, '{"all": true}', TRUE)
             ON CONFLICT (email) DO UPDATE SET
               password_hash = EXCLUDED.password_hash,
               password_salt = EXCLUDED.password_salt,
               permissions = '{"all": true}',
               is_active = TRUE,
               updated_at = NOW()
             RETURNING id, permissions, email_verified;`,
            [emailText, migrated.hash, migrated.salt],
          );
          const migratedAccount = migratedResult.rows[0];
          if (migratedAccount.email_verified === false) {
            return jsonResponse(
              { error: "Please verify your email address before signing in. Check your inbox for the verification link.", needs_verification: true },
              403,
            );
          }
          const token = generateToken();
          await runQuery(
            env,
            "INSERT INTO admin_sessions (token, admin_id) VALUES ($1, $2);",
            [token, migratedAccount.id],
          );
          return jsonResponse({
            success: true,
            token,
            permissions: migratedAccount.permissions || { all: true },
          });
        }
      } catch (legacyError) {
        console.error("legacy admin migration check failed:", legacyError);
      }

      if (legacyAccount || emailText === String(env.ADMIN_EMAIL || "").trim().toLowerCase()) {
        return jsonResponse({ error: "Incorrect email or password." }, 401);
      }
      return jsonResponse({ error: "Incorrect email or password.", code: "account_not_found" }, 404);
    }

    if (emailText === String(env.ADMIN_EMAIL || "").trim().toLowerCase()) {
      return jsonResponse({ error: "Incorrect email or password." }, 401);
    }
    return jsonResponse({ error: "Incorrect email or password.", code: "account_not_found" }, 404);
  } catch (err) {
    console.error("admin login error:", err);
    return jsonResponse(
      { error: "We couldn't sign you in right now. Please try again." },
      500,
    );
  }
}
