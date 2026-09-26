import { runQuery, jsonResponse } from "../../_lib/db.js";
import {
  requireAdminPermission,
  ADMIN_PERMISSIONS,
} from "../../_lib/adminAuth.js";
import { hashPassword } from "../../_lib/password.js";
import { sanitizeText, getRequestIp, isValidEmail, VALIDATION_MESSAGES } from "../../_lib/security.js";
import { logAudit } from "../../_lib/audit.js";

/** Main admin = full access ({"all": true}). Only they can edit or delete admin accounts. */
const isMainAdmin = (permissions) => Boolean(permissions && permissions.all);

function cleanPermissions(input, allowAll = false) {
  const value = input && typeof input === "object" ? input : {};
  if (allowAll && value.all) return { all: true };
  return Object.fromEntries(
    ADMIN_PERMISSIONS.map((permission) => [
      permission,
      Boolean(value[permission]),
    ]),
  );
}

const countMainAdmins = async (env) =>
  Number(
    (await runQuery(env, "SELECT COUNT(*)::int AS n FROM admin_accounts WHERE is_active = TRUE AND (permissions->>'all')::boolean IS TRUE;")).rows[0].n,
  );

/**
 * PUT    { id, email?, password?, permissions?, is_active? }  - edit
 * DELETE { id }                                               - delete
 * Main admin only. Nobody can delete themselves, and the last active
 * main admin can't be deleted, disabled or have full access removed -
 * so the dashboard can never be locked out.
 */
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
  const target = (await runQuery(env, "SELECT id, email, permissions, is_active FROM admin_accounts WHERE id = $1;", [id])).rows[0];
  if (!target) return jsonResponse({ error: "Admin account not found." }, 404);
  const targetIsMain = isMainAdmin(target.permissions) && target.is_active;
  const isSelf = Number(actor.id) === id;

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
      details: { email: target.email },
    });
    return jsonResponse({ success: true });
  }

  // PUT - edit
  const email = body.email !== undefined ? sanitizeText(body.email || "", 200).trim().toLowerCase() : target.email;
  if (!email) return jsonResponse({ error: "Email is required." }, 400);
  if (!isValidEmail(email)) return jsonResponse({ error: VALIDATION_MESSAGES.email }, 400);
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
      "UPDATE admin_accounts SET email = $1, permissions = $2, is_active = $3, updated_at = NOW() WHERE id = $4;",
      [email, JSON.stringify(permissions), isActive, id],
    );
    if (!isActive) await runQuery(env, "DELETE FROM admin_sessions WHERE admin_id = $1;", [id]);
  } catch (error) {
    return jsonResponse(
      { error: String(error.message).includes("unique") ? "Another admin already uses that email." : "Failed to update the admin account." },
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
    details: { email, permissions, is_active: isActive, password_changed: Boolean(password) },
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
  if (request.method === "GET") {
    const result = await runQuery(
      env,
      "SELECT id, email, permissions, is_active, created_at, updated_at FROM admin_accounts ORDER BY email;",
    );
    return jsonResponse({
      accounts: result.rows,
      me: auth.actor.id,
      can_manage: isMainAdmin(auth.actor.permissions),
    });
  }
  if (request.method === "PUT" || request.method === "DELETE") {
    return manageAccount(request, env, auth.actor);
  }
  try {
    const body = await request.json();
    const email = sanitizeText(body.email || "", 200)
      .trim()
      .toLowerCase();
    const password = sanitizeText(body.password || "");
    const permissions = cleanPermissions(body.permissions, isMainAdmin(auth.actor.permissions));
    if (email && !isValidEmail(email)) return jsonResponse({ error: VALIDATION_MESSAGES.email }, 400);
    if (!email || password.length < 8)
      return jsonResponse(
        { error: "Email and password of at least 8 characters are required." },
        400,
      );
    const { hash, salt } = await hashPassword(password);
    const result = await runQuery(
      env,
      "INSERT INTO admin_accounts (email, password_hash, password_salt, permissions) VALUES ($1, $2, $3, $4) RETURNING id, email, permissions;",
      [email, hash, salt, JSON.stringify(permissions)],
    );
    await logAudit(env, {
      actor_type: "admin",
      actor_id: auth.actor.id,
      actor_role: "admin",
      actor_ip: getRequestIp(request),
      action: "admin_account_created",
      target_type: "admin",
      target_id: result.rows[0].id,
      details: { email, permissions },
    });
    return jsonResponse({ success: true, account: result.rows[0] }, 201);
  } catch (error) {
    return jsonResponse(
      {
        error: String(error.message).includes("unique")
          ? "That admin email already exists."
          : "Failed to create admin account.",
      },
      500,
    );
  }
}
