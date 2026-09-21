/**
 * functions/_lib/auth.js
 * -----------------------------------------------------------------------
 * Authentication for the owner admin dashboard and kitchen Staff Portal.
 * Tokens are checked against database sessions in production and against
 * the in-memory fallback used by local runs without Neon credentials.
 * -----------------------------------------------------------------------
 */

import { runQuery, jsonResponse } from "./db.js";
import { getSession, isDbAvailable } from "./sessionStore.js";

function requiredPermission(pathname, role) {
  if (role === "staff") {
    if (pathname.includes("/staff/orders") || pathname.includes("/staff/order-status")) {
      return "orders";
    }
    return "orders";
  }

  if (pathname.includes("/admin/accounts")) return "admin_accounts";
  if (pathname.includes("/admin/customers")) return "customers";
  if (pathname.includes("/admin/marketing")) return "marketing";
  if (pathname.includes("/admin/audit")) return "audit";
  if (
    pathname.includes("/admin/menu") ||
    pathname.includes("/admin/categories") ||
    pathname.includes("/admin/addons") ||
    pathname.includes("/admin/upload")
  ) {
    return "menu";
  }
  if (pathname.includes("/admin/buffet")) return "buffet";
  if (pathname.includes("/admin/review")) return "reviews";
  if (
    pathname.includes("/admin/config") ||
    pathname.includes("/admin/password") ||
    pathname.includes("/admin/staff")
  ) {
    return "settings";
  }
  return "orders";
}

async function requireRole(request, env, { tokenEnvVar, label }) {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) {
    return jsonResponse(
      { error: `Unauthorized. Please log in again.` },
      401,
    );
  }

  const isAdmin = tokenEnvVar === "ADMIN_TOKEN";
  const role = isAdmin ? "admin" : "staff";
  const permissions = isDbAvailable(env)
    ? await requireDatabaseRole(env, token, isAdmin)
    : requireLocalRole(token, role);

  if (permissions.error) return permissions.error;

  const required = requiredPermission(new URL(request.url).pathname, role);
  if (!(permissions.value.all || permissions.value[required])) {
    return jsonResponse({ error: "Unauthorized. Please log in again." }, 401);
  }

  env.__actorId = permissions.value.__actorId;
  env.__actorRole = role;
  env.__actorPermissions = permissions.value;
  return null;
}

async function requireDatabaseRole(env, token, isAdmin) {
  const sessionTable = isAdmin ? "admin_sessions" : "staff_sessions";
  const accountTable = isAdmin ? "admin_accounts" : "staff_accounts";
  const accountId = isAdmin ? "admin_id" : "staff_id";

  try {
    const result = await runQuery(
      env,
      `
        SELECT a.id, a.email, a.permissions
        FROM ${sessionTable} s
        JOIN ${accountTable} a ON a.id = s.${accountId}
        WHERE s.token = $1 AND s.expires_at > NOW() AND a.is_active = TRUE;
      `,
      [token],
    );
    const account = result.rows[0];
    if (!account) {
      return { error: jsonResponse({ error: "Unauthorized. Please log in again." }, 401) };
    }
    const permissions = account.permissions && typeof account.permissions === "object"
      ? account.permissions
      : {};
    return { value: { ...permissions, __actorId: account.id } };
  } catch (err) {
    return { error: jsonResponse({ error: "Authentication service unavailable.", message: err.message }, 503) };
  }
}

function requireLocalRole(token, role) {
  const session = getSession(token);
  if (!session || session.actorType !== role) {
    return { error: jsonResponse({ error: "Unauthorized. Please log in again." }, 401) };
  }
  return { value: { ...(session.permissions || {}), __actorId: session.actorId } };
}

export { requireRole, requiredPermission };

export function requireAdmin(request, env) {
  return requireRole(request, env, {
    tokenEnvVar: "ADMIN_TOKEN",
    label: "Admin",
  });
}

export function requireStaff(request, env) {
  return requireRole(request, env, {
    tokenEnvVar: "STAFF_TOKEN",
    label: "Staff",
  });
}
