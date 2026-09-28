/**
 * functions/_lib/accountVerification.js
 * -----------------------------------------------------------------------
 * "Click the link before you can log in" for newly created admin/staff
 * accounts, mirroring the customer sign-up flow
 * (functions/api/auth/verify-email.js) but with two separate token
 * tables so admin and staff verification links can never be confused.
 * ----------------------------------------------------------------------- */
import { runQuery } from "./db.js";
import { generateToken } from "./password.js";
import { sendEmail } from "./email.js";

const VERIFY_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // a week - plenty of time to check a new work inbox

const readyTables = new Set();
async function ensureVerificationTable(env, tokenTable, accountTable, accountIdCol) {
  if (readyTables.has(tokenTable)) return;
  await runQuery(
    env,
    `
    CREATE TABLE IF NOT EXISTS ${tokenTable} (
      token       TEXT PRIMARY KEY,
      ${accountIdCol} INTEGER NOT NULL REFERENCES ${accountTable}(id) ON DELETE CASCADE,
      expires_at  TIMESTAMPTZ NOT NULL,
      used        BOOLEAN NOT NULL DEFAULT FALSE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `,
  );
  readyTables.add(tokenTable);
}

/**
 * Sends the "verify your email" link for a freshly created admin or
 * staff account. role: "admin" | "staff" - picks the token table, the
 * page the link lands the person on, and the wording of the email.
 */
export async function sendAccountVerificationEmail(env, { role, accountId, email, requestUrl, label }) {
  const isAdmin = role === "admin";
  const tokenTable = isAdmin ? "admin_email_verifications" : "staff_email_verifications";
  const accountTable = isAdmin ? "admin_accounts" : "staff_accounts";
  const accountIdCol = isAdmin ? "admin_id" : "staff_id";
  await ensureVerificationTable(env, tokenTable, accountTable, accountIdCol);

  const token = generateToken();
  const expiresAt = new Date(Date.now() + VERIFY_TOKEN_TTL_MS).toISOString();
  await runQuery(
    env,
    `INSERT INTO ${tokenTable} (token, ${accountIdCol}, expires_at) VALUES ($1, $2, $3);`,
    [token, accountId, expiresAt],
  );

  const origin = new URL(requestUrl).origin;
  const verifyLink = `${origin}/api/${role}/verify-email?token=${encodeURIComponent(token)}`;
  await sendEmail(env, {
    to: email,
    subject: "Verify your Fulude's Cafe account",
    html: `<p>Hi${label ? " " + label : ""},</p><p>An account was created for you on Fulude's Cafe (${isAdmin ? "admin" : "staff"} access). Click the link below to verify your email - you won't be able to sign in until you do.</p><p><a href="${verifyLink}">${verifyLink}</a></p><p>This link is valid for 7 days. If you weren't expecting this, you can ignore this email.</p>`,
  });
}
