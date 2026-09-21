import { runQuery, jsonResponse } from "../../_lib/db.js";
import {
  requireAdminPermission,
  ADMIN_PERMISSIONS,
} from "../../_lib/adminAuth.js";
import { hashPassword } from "../../_lib/password.js";
import { sanitizeText, getRequestIp } from "../../_lib/security.js";
import { logAudit } from "../../_lib/audit.js";

function cleanPermissions(input) {
  const value = input && typeof input === "object" ? input : {};
  return Object.fromEntries(
    ADMIN_PERMISSIONS.map((permission) => [
      permission,
      Boolean(value[permission]),
    ]),
  );
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
    return jsonResponse({ accounts: result.rows });
  }
  try {
    const body = await request.json();
    const email = sanitizeText(body.email || "", 200)
      .trim()
      .toLowerCase();
    const password = sanitizeText(body.password || "");
    const permissions = cleanPermissions(body.permissions);
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
