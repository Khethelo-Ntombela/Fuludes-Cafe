// CRUD for admin-managed staff logins
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { requireAdminPermission } from "../../_lib/adminAuth.js";
import { hashPassword } from "../../_lib/password.js";
import { logAudit } from "../../_lib/audit.js";
import { getRequestIp, sanitizeText, isValidEmail, isValidName, normalizePhone, VALIDATION_MESSAGES } from "../../_lib/security.js";
import { ensureLockoutColumns } from "../../_lib/accountLockout.js";
import { sendAccountVerificationEmail } from "../../_lib/accountVerification.js";


// Turns a permissions object (or its stored JSON text) into a short readable list for the audit log.
function permissionsText(value) {
  try {
    const p = typeof value === "string" ? JSON.parse(value) : value;
    if (!p || typeof p !== "object") return "none";
    if (p.all) return "all";
    const on = Object.keys(p).filter((k) => p[k]);
    return on.length ? on.join(", ") : "none";
  } catch {
    return "none";
  }
}

function normalizeEmail(value) {
  return sanitizeText(value || "")
    .trim()
    .toLowerCase();
}

function cleanPermissions(input) {
  // Staff only needs orders permission for the kitchen board
  return { orders: true };
}

async function ensureStaffTable(env) {
  await runQuery(
    env,
    `
    CREATE TABLE IF NOT EXISTS staff_accounts (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `,
  );
  await runQuery(
    env,
    `ALTER TABLE staff_accounts ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '{"orders": true}';`,
  );
}

export async function onRequest(context) {
  const { request, env } = context;
  // Staff accounts live under Settings, which helper admins can never reach.
  const auth = await requireAdminPermission(request, env, "settings");
  if (auth.error) return auth.error;

  const requestIp = getRequestIp(request);

  await ensureStaffTable(env);
  await ensureLockoutColumns(env, "staff_accounts");

  if (request.method === "GET") {
    try {
      const result = await runQuery(
        env,
        "SELECT id, name, email, permissions, is_active, is_locked, email_verified, created_at, updated_at FROM staff_accounts ORDER BY name, email;",
      );
      return jsonResponse({ success: true, staff: result.rows });
    } catch (err) {
      return jsonResponse(
        { error: "Failed to load staff accounts.", message: err.message },
        500,
      );
    }
  }

  if (request.method === "POST") {
    try {
      const body = await request.json();
      const name = sanitizeText(body.name || "").trim();
      const email = normalizeEmail(body.email);
      const password = sanitizeText(body.password || "");
      const permissions = cleanPermissions(body.permissions);

      if (!name || !email || !password) {
        return jsonResponse(
          { error: "Name, email, and password are required." },
          400,
        );
      }
      if (!isValidName(name)) return jsonResponse({ error: VALIDATION_MESSAGES.name }, 400);
      if (!isValidEmail(email)) return jsonResponse({ error: VALIDATION_MESSAGES.email }, 400);
      if (password.length < 8) {
        return jsonResponse(
          { error: "Password must be at least 8 characters." },
          400,
        );
      }

      const { hash, salt } = await hashPassword(password);
      const inserted = await runQuery(
        env,
        "INSERT INTO staff_accounts (name, email, password_hash, password_salt, permissions, email_verified) VALUES ($1, $2, $3, $4, $5, FALSE) RETURNING id;",
        [name, email, hash, salt, JSON.stringify(permissions)],
      );
      // They can't sign in until they click the emailed link.
      await sendAccountVerificationEmail(env, {
        role: "staff",
        accountId: inserted.rows[0].id,
        email,
        requestUrl: request.url,
        label: name,
      });

      await logAudit(env, {
        actor_type: "admin",
        actor_role: "admin",
        actor_ip: requestIp,
        action: "staff_account_created",
        target_type: "staff",
        target_id: inserted.rows[0].id,
        details: { name, email, permissions: permissionsText(permissions) },
      });
      return jsonResponse({ success: true });
    } catch (err) {
      if (String(err.message).includes("unique")) {
        return jsonResponse(
          { error: "A staff account with that email already exists." },
          409,
        );
      }
      return jsonResponse(
        { error: "Failed to create staff account.", message: err.message },
        500,
      );
    }
  }

  if (request.method === "PUT") {
    try {
      const body = await request.json();
      const id = Number(body.id);
      if (!id) {
        return jsonResponse({ error: "Staff account id is required." }, 400);
      }

      // Re-enable a locked account (locked after 4 failed sign-ins).
      if (body.unlock === true) {
        await runQuery(
          env,
          "UPDATE staff_accounts SET is_locked = FALSE, failed_login_attempts = 0 WHERE id = $1;",
          [id],
        );
        const unlocked = await runQuery(env, "SELECT name, email FROM staff_accounts WHERE id = $1;", [id]);
        await logAudit(env, {
          actor_type: "admin",
          actor_role: "admin",
          actor_ip: requestIp,
          action: "staff_account_unlocked",
          target_type: "staff",
          target_id: id,
          details: { name: unlocked.rows[0]?.name, email: unlocked.rows[0]?.email },
        });
        return jsonResponse({ success: true });
      }

      const name = sanitizeText(body.name || "").trim();
      const password = sanitizeText(body.password || "");
      const permissions = cleanPermissions(body.permissions);

      if (!name) {
        return jsonResponse(
          { error: "Staff account id and name are required." },
          400,
        );
      }
      if (!isValidName(name)) return jsonResponse({ error: VALIDATION_MESSAGES.name }, 400);

      // The email address is fixed once the account exists - it's never
      // read from the request, so it can't be changed by editing.
      let query =
        "UPDATE staff_accounts SET name = $1, permissions = $2, updated_at = NOW() WHERE id = $3;";
      const params = [name, JSON.stringify(permissions), id];

      if (password) {
        if (password.length < 8) {
          return jsonResponse(
            { error: "Password must be at least 8 characters." },
            400,
          );
        }
        const { hash, salt } = await hashPassword(password);
        query =
          "UPDATE staff_accounts SET name = $1, permissions = $2, password_hash = $3, password_salt = $4, updated_at = NOW() WHERE id = $5;";
        params.splice(2, 0, hash, salt);
      }

      const before = (await runQuery(env, "SELECT name, email, permissions FROM staff_accounts WHERE id = $1;", [id])).rows[0];
      await runQuery(env, query, params);

      const changes = [];
      if (before && before.name !== name) changes.push({ label: "Name", from: before.name, to: name });
      const oldPerms = permissionsText(before?.permissions);
      const newPerms = permissionsText(permissions);
      if (before && oldPerms !== newPerms) changes.push({ label: "Permissions", from: oldPerms, to: newPerms });
      if (password) changes.push({ label: "Password", from: "-", to: "changed" });
      await logAudit(env, {
        actor_type: "admin",
        actor_role: "admin",
        actor_ip: requestIp,
        action: "staff_account_updated",
        target_type: "staff",
        target_id: id,
        details: changes.length
          ? { summary: before?.email ? `Staff account ${before.email}` : undefined, changes }
          : { summary: "Saved without changing anything" },
      });
      return jsonResponse({ success: true });
    } catch (err) {
      if (String(err.message).includes("unique")) {
        return jsonResponse(
          { error: "A staff account with that email already exists." },
          409,
        );
      }
      return jsonResponse(
        { error: "Failed to update staff account.", message: err.message },
        500,
      );
    }
  }

  if (request.method === "DELETE") {
    try {
      const url = new URL(request.url);
      const id = Number(url.searchParams.get("id"));
      if (!id) {
        return jsonResponse({ error: "Staff account id is required." }, 400);
      }
      const removed = (await runQuery(env, "SELECT name, email FROM staff_accounts WHERE id = $1;", [id])).rows[0];
      await runQuery(env, "DELETE FROM staff_accounts WHERE id = $1;", [id]);

      await logAudit(env, {
        actor_type: "admin",
        actor_role: "admin",
        actor_ip: requestIp,
        action: "staff_account_deleted",
        target_type: "staff",
        target_id: id,
        details: { name: removed?.name, email: removed?.email },
      });
      return jsonResponse({ success: true });
    } catch (err) {
      return jsonResponse(
        { error: "Failed to delete staff account.", message: err.message },
        500,
      );
    }
  }

  return jsonResponse({ error: "Method not allowed." }, 405);
}
