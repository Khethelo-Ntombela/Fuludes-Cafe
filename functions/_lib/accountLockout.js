/**
 * functions/_lib/accountLockout.js
 * -----------------------------------------------------------------------
 * Shared failed-login lockout + email-verification-before-first-login
 * behaviour for admin_accounts and staff_accounts (mirrors the pattern
 * already used for customers in functions/api/auth/login.js).
 *
 * Lockout: after MAX_FAILED_ATTEMPTS wrong passwords in a row, the
 * account is locked (is_locked = TRUE). Unlike customers, admin/staff
 * accounts have NO self-service way to unlock - only the main admin can
 * re-enable a locked account from the Admin/Staff Accounts settings
 * panel (see the `unlock` handling in accounts.js / staff.js).
 *
 * Email verification: a new admin or staff account created by the main
 * admin starts with email_verified = FALSE and can't log in until they
 * click the link emailed to them (functions/api/admin/verify-email.js,
 * functions/api/staff/verify-email.js). Accounts created before this
 * feature existed, and the env-var-based bootstrap admin/staff login,
 * are always considered verified - see migration 014.
 * ----------------------------------------------------------------------- */
import { runQuery } from "./db.js";

export const MAX_FAILED_ATTEMPTS = 4;

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

/**
 * Call after a wrong password. Increments the counter, locks the account
 * once it reaches MAX_FAILED_ATTEMPTS, and returns the response to send
 * back (still a generic "incorrect password" message below the limit).
 */
export async function recordFailedLogin(env, table, accountId, attemptsSoFar, contactLabel) {
  const attempts = attemptsSoFar + 1;
  const shouldLock = attempts >= MAX_FAILED_ATTEMPTS;
  await runQuery(
    env,
    `UPDATE ${table} SET failed_login_attempts = $1, is_locked = $2 WHERE id = $3;`,
    [attempts, shouldLock, accountId],
  );
  if (shouldLock) {
    return {
      error: `This account is now locked after ${MAX_FAILED_ATTEMPTS} failed attempts. Please contact ${contactLabel} to have it re-enabled.`,
      locked: true,
    };
  }
  return { error: "Incorrect email or password." };
}

export async function clearFailedLogins(env, table, accountId) {
  await runQuery(env, `UPDATE ${table} SET failed_login_attempts = 0 WHERE id = $1;`, [accountId]);
}
