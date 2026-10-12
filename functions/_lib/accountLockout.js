// Failed-login lockout and email verification for admin and staff accounts.
import { runQuery } from "./db.js";

export const MAX_FAILED_ATTEMPTS = 4;

/** Shown on the admin/staff login screens whenever the account is locked. */
export const LOCKED_MESSAGE = "Please contact admin, your account has been locked.";

const readyTables = new Set();

/** table: "admin_accounts" | "staff_accounts" */
export async function ensureLockoutColumns(env, table) {
  if (readyTables.has(table)) return;
  await runQuery(env, `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER NOT NULL DEFAULT 0;`);
  await runQuery(env, `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS is_locked BOOLEAN NOT NULL DEFAULT FALSE;`);
  // Existing accounts (and the env-var bootstrap account) are verified by
  // default - only newly created accounts start unverified.
  await runQuery(env, `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT TRUE;`);
  readyTables.add(table);
}

// Call after a wrong password
export async function recordFailedLogin(env, table, accountId, attemptsSoFar, contactLabel) {
  const attempts = attemptsSoFar + 1;
  const shouldLock = attempts >= MAX_FAILED_ATTEMPTS;
  await runQuery(
    env,
    `UPDATE ${table} SET failed_login_attempts = $1, is_locked = $2 WHERE id = $3;`,
    [attempts, shouldLock, accountId],
  );
  if (shouldLock) {
    return { error: LOCKED_MESSAGE, locked: true };
  }
  return { error: "Incorrect email or password." };
}

export async function clearFailedLogins(env, table, accountId) {
  await runQuery(env, `UPDATE ${table} SET failed_login_attempts = 0 WHERE id = $1;`, [accountId]);
}
