// POST /api/staff/login
import { jsonResponse, runQuery } from "../../_lib/db.js";
import { sanitizeText } from "../../_lib/security.js";
import { verifyPassword, generateToken, hashPassword } from "../../_lib/password.js";
import { saveSession, isDbAvailable } from "../../_lib/sessionStore.js";
import { ensureLockoutColumns, recordFailedLogin, clearFailedLogins, LOCKED_MESSAGE } from "../../_lib/accountLockout.js";

const VERIFY_MESSAGE =
  "Please verify your email address before signing in. Check your inbox for the verification link.";

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
        String(env.STAFF_EMAIL || "")
          .trim()
          .toLowerCase() && passwordText === String(env.STAFF_PASSWORD || "");

    if (envValid) {
      const token = generateToken();
      if (isDbAvailable(env)) {
        await runQuery(
          env,
          `CREATE TABLE IF NOT EXISTS staff_accounts (
          id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL, password_salt TEXT NOT NULL,
          permissions JSONB NOT NULL DEFAULT '{"orders": true}', is_active BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );`,
        );
        await runQuery(
          env,
          `ALTER TABLE staff_accounts ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '{"orders": true}';`,
        );
        await runQuery(
          env,
          `CREATE TABLE IF NOT EXISTS staff_sessions (
          token TEXT PRIMARY KEY, staff_id INTEGER NOT NULL REFERENCES staff_accounts(id) ON DELETE CASCADE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '12 hours')
        );`,
        );
        await ensureLockoutColumns(env, "staff_accounts");
        let accountResult = await runQuery(
          env,
          "SELECT id, permissions FROM staff_accounts WHERE email = $1 AND is_active = TRUE LIMIT 1;",
          [emailText],
        );
        let account = accountResult.rows[0];
        if (account) {
          // The bootstrap staff login is always trusted and never locked out.
          await runQuery(env, "UPDATE staff_accounts SET is_locked = FALSE, failed_login_attempts = 0 WHERE id = $1;", [account.id]);
        }
        if (!account) {
          const hashed = await hashPassword(passwordText);
          const insertResult = await runQuery(
            env,
            "INSERT INTO staff_accounts (name, email, password_hash, password_salt, permissions) VALUES ($1, $2, $3, $4, '{\"orders\": true}') RETURNING id, permissions;",
            [emailText, emailText, hashed.hash, hashed.salt],
          );
          account = insertResult.rows[0];
        }
        await runQuery(
          env,
          "INSERT INTO staff_sessions (token, staff_id) VALUES ($1, $2);",
          [token, account.id],
        );
        return jsonResponse({
          success: true,
          token,
          permissions: account.permissions || {},
        });
      } else {
        saveSession(token, "staff", 0, { orders: true });
        return jsonResponse({
          success: true,
          token,
          permissions: { orders: true },
        });
      }
    }

    if (isDbAvailable(env)) {
      await runQuery(
        env,
        `CREATE TABLE IF NOT EXISTS staff_accounts (
        id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL, password_salt TEXT NOT NULL,
        permissions JSONB NOT NULL DEFAULT '{"orders": true}', is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );`,
      );
      await runQuery(
        env,
        `ALTER TABLE staff_accounts ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '{"orders": true}';`,
      );
      await runQuery(
        env,
        `CREATE TABLE IF NOT EXISTS staff_sessions (
        token TEXT PRIMARY KEY, staff_id INTEGER NOT NULL REFERENCES staff_accounts(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '12 hours')
      );`,
      );
      await ensureLockoutColumns(env, "staff_accounts");
      const result = await runQuery(
        env,
        "SELECT id, password_hash, password_salt, permissions, failed_login_attempts, is_locked, email_verified FROM staff_accounts WHERE email = $1 AND is_active = TRUE LIMIT 1;",
        [emailText],
      );
      const account = result.rows[0];
      if (account) {
        // Locked accounts are refused whether or not the password is right,
        // until the main admin unlocks them.
        if (account.is_locked) {
          return jsonResponse({ error: LOCKED_MESSAGE, locked: true }, 423);
        }
        // New accounts must click the emailed verification link first.
        if (account.email_verified === false) {
          return jsonResponse(
            { error: VERIFY_MESSAGE, needs_verification: true },
            403,
          );
        }
        const valid = await verifyPassword(
          passwordText,
          account.password_hash,
          account.password_salt,
        );
        if (valid) {
          await clearFailedLogins(env, "staff_accounts", account.id);
          const token = generateToken();
          await runQuery(
            env,
            "INSERT INTO staff_sessions (token, staff_id) VALUES ($1, $2);",
            [token, account.id],
          );
          return jsonResponse({
            success: true,
            token,
            permissions: account.permissions || {},
          });
        }
        const failed = await recordFailedLogin(env, "staff_accounts", account.id, account.failed_login_attempts, "the admin");
        return jsonResponse(failed, failed.locked ? 423 : 401);
      }

      let legacyAccount = null;
      try {
        const legacyResult = await runQuery(
          env,
          "SELECT email, password FROM users WHERE LOWER(email) = $1 AND LOWER(role) = 'staff' LIMIT 1;",
          [emailText],
        );
        legacyAccount = legacyResult.rows[0];
      } catch {
        // Older databases may not have the legacy users table.
      }
      if (legacyAccount && passwordText === String(legacyAccount.password || "")) {
        const migrated = await hashPassword(passwordText);
        const migratedResult = await runQuery(
          env,
          `INSERT INTO staff_accounts (name, email, password_hash, password_salt, permissions)
           VALUES ($1, $2, $3, $4, '{"orders": true}')
           ON CONFLICT (email) DO UPDATE SET
             password_hash = EXCLUDED.password_hash,
             password_salt = EXCLUDED.password_salt,
             permissions = '{"orders": true}',
             is_active = TRUE,
             updated_at = NOW()
           RETURNING id, permissions, email_verified;`,
          [emailText, emailText, migrated.hash, migrated.salt],
        );
        const migratedAccount = migratedResult.rows[0];
        if (migratedAccount.email_verified === false) {
          return jsonResponse(
            { error: VERIFY_MESSAGE, needs_verification: true },
            403,
          );
        }
        const token = generateToken();
        await runQuery(
          env,
          "INSERT INTO staff_sessions (token, staff_id) VALUES ($1, $2);",
          [token, migratedAccount.id],
        );
        return jsonResponse({
          success: true,
          token,
          permissions: migratedAccount.permissions || { orders: true },
        });
      }

      if (legacyAccount || emailText === String(env.STAFF_EMAIL || "").trim().toLowerCase()) {
        return jsonResponse({ error: "Incorrect email or password." }, 401);
      }
      return jsonResponse({ error: "Incorrect email or password.", code: "account_not_found" }, 404);
    }

    if (emailText === String(env.STAFF_EMAIL || "").trim().toLowerCase()) {
      return jsonResponse({ error: "Incorrect email or password." }, 401);
    }
    return jsonResponse({ error: "Incorrect email or password.", code: "account_not_found" }, 404);
  } catch (err) {
    console.error("staff login error:", err);
    return jsonResponse(
      { error: "We couldn't sign you in right now. Please try again." },
      500,
    );
  }
}
