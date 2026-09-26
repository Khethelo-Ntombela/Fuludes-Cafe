/**
 * functions/api/admin/staff.js
 * -----------------------------------------------------------------------
 * CRUD for admin-managed staff logins.
 *
 * GET    /api/admin/staff                   -> list staff accounts
 * POST   /api/admin/staff                   -> create staff account { name, email, password }
 * PUT    /api/admin/staff                   -> update staff account { id, name, email, password? }
 * DELETE /api/admin/staff?id=1              -> delete staff account
 * ----------------------------------------------------------------------- */
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { requireAdmin } from "../../_lib/auth.js";
import { hashPassword } from "../../_lib/password.js";
import { logAudit } from "../../_lib/audit.js";
import { getRequestIp, sanitizeText, isValidEmail, isValidName, normalizePhone, VALIDATION_MESSAGES } from "../../_lib/security.js";

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
  const authError = await requireAdmin(request, env);
  if (authError) return authError;

  const requestIp = getRequestIp(request);

  await ensureStaffTable(env);

  if (request.method === "GET") {
    try {
      const result = await runQuery(
        env,
        "SELECT id, name, email, permissions, is_active, created_at, updated_at FROM staff_accounts ORDER BY name, email;",
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
      await runQuery(
        env,
        "INSERT INTO staff_accounts (name, email, password_hash, password_salt, permissions) VALUES ($1, $2, $3, $4, $5);",
        [name, email, hash, salt, JSON.stringify(permissions)],
      );

      await logAudit(env, {
        actor_type: "admin",
        actor_role: "admin",
        actor_ip: requestIp,
        action: "staff_account_created",
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
      const name = sanitizeText(body.name || "").trim();
      const email = normalizeEmail(body.email);
      const password = sanitizeText(body.password || "");
      const permissions = cleanPermissions(body.permissions);

      if (!id || !name || !email) {
        return jsonResponse(
          { error: "Staff account id, name, and email are required." },
          400,
        );
      }
      if (!isValidName(name)) return jsonResponse({ error: VALIDATION_MESSAGES.name }, 400);
      if (!isValidEmail(email)) return jsonResponse({ error: VALIDATION_MESSAGES.email }, 400);

      let query =
        "UPDATE staff_accounts SET name = $1, email = $2, permissions = $3, updated_at = NOW() WHERE id = $4;";
      const params = [name, email, JSON.stringify(permissions), id];

      if (password) {
        if (password.length < 8) {
          return jsonResponse(
            { error: "Password must be at least 8 characters." },
            400,
          );
        }
        const { hash, salt } = await hashPassword(password);
        query =
          "UPDATE staff_accounts SET name = $1, email = $2, permissions = $3, password_hash = $4, password_salt = $5, updated_at = NOW() WHERE id = $6;";
        params.splice(3, 0, hash, salt);
      }

      await runQuery(env, query, params);

      await logAudit(env, {
        actor_type: "admin",
        actor_role: "admin",
        actor_ip: requestIp,
        action: "staff_account_updated",
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
      await runQuery(env, "DELETE FROM staff_accounts WHERE id = $1;", [id]);

      await logAudit(env, {
        actor_type: "admin",
        actor_role: "admin",
        actor_ip: requestIp,
        action: "staff_account_deleted",
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
