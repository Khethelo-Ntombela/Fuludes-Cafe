import { runQuery, jsonResponse } from "../../_lib/db.js";
import {
  requireAdminPermission,
  ADMIN_PERMISSIONS,
} from "../../_lib/adminAuth.js";
import { hashPassword } from "../../_lib/password.js";
import { sanitizeText, getRequestIp, isValidEmail, VALIDATION_MESSAGES } from "../../_lib/security.js";
import { logAudit } from "../../_lib/audit.js";
import { ensureLockoutColumns } from "../../_lib/accountLockout.js";
import { sendAccountVerificationEmail } from "../../_lib/accountVerification.js";

/** Main admin = full access ({"all": true}). Only they can edit, delete or create admin accounts. */
const isMainAdmin = (permissions) => Boolean(permissions && permissions.all);

// Helper (non-main) admins can never reach Settings, Marketing or manage other Admin Accounts
const RESTRICTED_FOR_HELPERS = ["settings", "marketing", "admin_accounts"];

// A main admin can create at most this many helper (non-full-access)
// admin accounts.
const MAX_HELPER_ADMINS = 2;

function cleanPermissions(input, allowAll = false) {
  const value = input && typeof input === "object" ? input : {};
  if (allowAll && value.all) return { all: true };
  return Object.fromEntries(
    ADMIN_PERMISSIONS.map((permission) => [
      permission,
      RESTRICTED_FOR_HELPERS.includes(permission) ? false : Boolean(value[permission]),
    ]),
  );
}

const countMainAdmins = async (env) =>
  Number(
    (await runQuery(env, "SELECT COUNT(*)::int AS n FROM admin_accounts WHERE is_active = TRUE AND (permissions->>'all')::boolean IS TRUE;")).rows[0].n,
  );

const countHelperAdmins = async (env) =>
  Number(
    (await runQuery(env, "SELECT COUNT(*)::int AS n FROM admin_accounts WHERE is_active = TRUE AND COALESCE((permissions->>'all')::boolean, FALSE) IS FALSE;")).rows[0].n,
  );

// PUT { id, username?, password?, permissions?, is_active?, unlock?
async function manageAccount(request, env, actor) {
  if (!isMainAdmin(actor.permissions)) {
    return jsonResponse({ error: "Only the main admin (full access) can edit or delete admin accounts." }, 403);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body." }, 400);
  }
  const id = parseInt(body.id, 10);
  if (!Number.isInteger(id)) return jsonResponse({ error: "A valid account id is required." }, 400);
  const target = (await runQuery(env, "SELECT id, email, username, permissions, is_active FROM admin_accounts WHERE id = $1;", [id])).rows[0];
  if (!target) return jsonResponse({ error: "Admin account not found." }, 404);
  const targetIsMain = isMainAdmin(target.permissions) && target.is_active;
  const isSelf = Number(actor.id) === id;

  // A main admin account can never be edited, unlocked, disabled or
  // deleted by any other admin - only its own owner can change it.
  if (isMainAdmin(target.permissions) && !isSelf) {
    return jsonResponse({ error: "A main admin account can't be changed by any other admin." }, 403);
  }

  if (request.method === "DELETE") {
    if (isSelf) return jsonResponse({ error: "You can't delete your own account." }, 400);
    if (targetIsMain && (await countMainAdmins(env)) <= 1) {
      return jsonResponse({ error: "This is the only main admin - it can't be deleted." }, 400);
    }
    await runQuery(env, "DELETE FROM admin_accounts WHERE id = $1;", [id]); // their sessions are removed with it
    await logAudit(env, {
      actor_type: "admin",
      actor_id: actor.id,
      actor_role: "admin",
      actor_ip: getRequestIp(request),
      action: "admin_account_deleted",
      target_type: "admin",
      target_id: id,
      details: { email: target.email, username: target.username },
    });
    return jsonResponse({ success: true });
  }

  // PUT - edit
  const email = target.email;
  await ensureLockoutColumns(env, "admin_accounts");
  if (body.unlock === true) {
    await runQuery(env, "UPDATE admin_accounts SET is_locked = FALSE, failed_login_attempts = 0 WHERE id = $1;", [id]);
    await logAudit(env, {
      actor_type: "admin",
      actor_id: actor.id,
      actor_role: "admin",
      actor_ip: getRequestIp(request),
      action: "admin_account_unlocked",
      target_type: "admin",
      target_id: id,
      details: { email },
    });
    return jsonResponse({ success: true });
  }
  const username = body.username !== undefined ? (sanitizeText(body.username || "", 100).trim() || null) : target.username;
  const permissions = body.permissions !== undefined ? cleanPermissions(body.permissions, true) : target.permissions;
  const isActive = body.is_active !== undefined ? Boolean(body.is_active) : target.is_active;
  if (isSelf && (!isMainAdmin(permissions) || !isActive)) {
    return jsonResponse({ error: "You can't remove your own full access or disable yourself." }, 400);
  }
  if (targetIsMain && (!isMainAdmin(permissions) || !isActive) && (await countMainAdmins(env)) <= 1) {
    return jsonResponse({ error: "This is the only main admin - keep full access on at least one account." }, 400);
  }
  const password = sanitizeText(body.password || "");
  if (password && password.length < 8) return jsonResponse({ error: "A new password needs at least 8 characters." }, 400);

  try {
    if (password) {
      const { hash, salt } = await hashPassword(password);
      await runQuery(env, "UPDATE admin_accounts SET password_hash = $1, password_salt = $2 WHERE id = $3;", [hash, salt, id]);
      // Sign them out everywhere so the old password can't keep working.
      if (!isSelf) await runQuery(env, "DELETE FROM admin_sessions WHERE admin_id = $1;", [id]);
    }
    await runQuery(
      env,
      "UPDATE admin_accounts SET username = $1, permissions = $2, is_active = $3, updated_at = NOW() WHERE id = $4;",
      [username, JSON.stringify(permissions), isActive, id],
    );
    if (!isActive) await runQuery(env, "DELETE FROM admin_sessions WHERE admin_id = $1;", [id]);
  } catch (error) {
    return jsonResponse(
      { error: String(error.message).includes("unique") ? "Another admin already uses that username." : "Failed to update the admin account." },
      400,
    );
  }
  await logAudit(env, {
    actor_type: "admin",
    actor_id: actor.id,
    actor_role: "admin",
    actor_ip: getRequestIp(request),
    action: "admin_account_updated",
    target_type: "admin",
    target_id: id,
    details: { email, username, permissions, is_active: isActive, password_changed: Boolean(password) },
  });
  return jsonResponse({ success: true });
}

export async function onRequest(context) {
  const { request, env } = context;
  const auth = await requireAdminPermission(request, env, "admin_accounts");
  if (auth.error) return auth.error;
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
    `ALTER TABLE admin_accounts ADD COLUMN IF NOT EXISTS username TEXT;`,
  );
  await runQuery(
    env,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_accounts_username ON admin_accounts(username) WHERE username IS NOT NULL;`,
  );
  await ensureLockoutColumns(env, "admin_accounts");
  if (request.method === "GET") {
    const result = await runQuery(
      env,
      "SELECT id, email, username, permissions, is_active, is_locked, email_verified, created_at, updated_at FROM admin_accounts ORDER BY email;",
    );
    return jsonResponse({
      accounts: result.rows,
      me: auth.actor.id,
      can_manage: isMainAdmin(auth.actor.permissions),
      helper_limit: MAX_HELPER_ADMINS,
      helper_count: await countHelperAdmins(env),
    });
  }
  if (request.method === "PUT" || request.method === "DELETE") {
    return manageAccount(request, env, auth.actor);
  }

  // POST - create
  if (!isMainAdmin(auth.actor.permissions)) {
    return jsonResponse({ error: "Only the main admin (full access) can create admin accounts." }, 403);
  }
  try {
    const body = await request.json();
    const email = sanitizeText(body.email || "", 200)
      .trim()
      .toLowerCase();
    const username = sanitizeText(body.username || "", 100).trim() || null;
    const password = sanitizeText(body.password || "");
    const permissions = cleanPermissions(body.permissions, isMainAdmin(auth.actor.permissions));
    if (email && !isValidEmail(email)) return jsonResponse({ error: VALIDATION_MESSAGES.email }, 400);
    if (!email || password.length < 8)
      return jsonResponse(
        { error: "Email and password of at least 8 characters are required." },
        400,
      );
    if (!isMainAdmin(permissions) && (await countHelperAdmins(env)) >= MAX_HELPER_ADMINS) {
      return jsonResponse({ error: `You've reached the ${MAX_HELPER_ADMINS}-admin limit.` }, 400);
    }
    const { hash, salt } = await hashPassword(password);
    const result = await runQuery(
      env,
      "INSERT INTO admin_accounts (email, username, password_hash, password_salt, permissions, email_verified) VALUES ($1, $2, $3, $4, $5, FALSE) RETURNING id, email, username, permissions;",
      [email, username, hash, salt, JSON.stringify(permissions)],
    );
    await sendAccountVerificationEmail(env, {
      role: "admin",
      accountId: result.rows[0].id,
      email,
      requestUrl: request.url,
      label: username,
    });
    await logAudit(env, {
      actor_type: "admin",
      actor_id: auth.actor.id,
      actor_role: "admin",
      actor_ip: getRequestIp(request),
      action: "admin_account_created",
      target_type: "admin",
      target_id: result.rows[0].id,
      details: { email, username, permissions },
    });
    return jsonResponse({ success: true, account: result.rows[0] }, 201);
  } catch (error) {
    return jsonResponse(
      {
        error: String(error.message).includes("unique")
          ? (String(error.message).includes("username")
              ? "Another admin already uses that username."
              : "That admin email already exists.")
          : "Failed to create admin account.",
      },
      500,
    );
  }
}
