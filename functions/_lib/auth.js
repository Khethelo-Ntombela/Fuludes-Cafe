// Authentication for the owner admin dashboard and kitchen Staff Portal

import { runQuery, jsonResponse } from "./db.js";
import { getSession, isDbAvailable } from "./sessionStore.js";

function requiredPermission(pathname, role) {
  if (role === "staff") {
    if (pathname.includes("/staff/orders") || pathname.includes("/staff/order-status")) {
      return "orders";
    }
    return "orders";
  }

  if (pathname.endsWith("/admin/me")) return null; // any signed-in admin may read their own permissions
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
    pathname.includes("/admin/yoco") ||
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
  if (required && !(permissions.value.all || permissions.value[required])) {
    // Signed in, just not allowed here - 403, so the page doesn't treat it as an expired session.
    return jsonResponse({ error: "You don't have access to this section.", forbidden: true }, 403);
  }

  env.__actorId = permissions.value.__actorId;
  env.__actorName = permissions.value.__actorName;
  env.__actorRole = role;
  env.__actorPermissions = permissions.value;
  return null;
}

let adminUsernameColumnReady = false;
async function ensureAdminUsernameColumn(env) {
  if (adminUsernameColumnReady) return;
  await runQuery(env, "ALTER TABLE admin_accounts ADD COLUMN IF NOT EXISTS username TEXT;");
  adminUsernameColumnReady = true;
}

async function requireDatabaseRole(env, token, isAdmin) {
  const sessionTable = isAdmin ? "admin_sessions" : "staff_sessions";
  const accountTable = isAdmin ? "admin_accounts" : "staff_accounts";
  const accountId = isAdmin ? "admin_id" : "staff_id";
  // Admins are identified by a username in the audit log; staff already
  // had a "name" field, which is what's used for them (see 013_audit_actor_name.sql).
  const nameColumn = isAdmin ? "a.username" : "a.name";
  if (isAdmin) await ensureAdminUsernameColumn(env);

  try {
    const result = await runQuery(
      env,
      `
        SELECT a.id, a.email, a.permissions, ${nameColumn} AS actor_name
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
    // Admins without a username set yet fall back to their email, so the
    // audit log is never blank for older accounts.
    const actorName = account.actor_name || (isAdmin ? account.email : null);
    return { value: { ...permissions, __actorId: account.id, __actorName: actorName } };
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
