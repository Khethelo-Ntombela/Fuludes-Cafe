import { jsonResponse } from "./db.js";
import { requireRole, requiredPermission } from "./auth.js";

export const ADMIN_PERMISSIONS = [
  "customers",
  "orders",
  "menu",
  "buffet",
  "reviews",
  "settings",
  "marketing",
  "audit",
  "admin_accounts",
];

export async function requireAdminPermission(request, env, permission) {
  const authError = await requireRole(request, env, {
    tokenEnvVar: "ADMIN_TOKEN",
    label: "Admin",
  });
  if (authError) return { error: authError };

  const permissions = env.__actorPermissions || {};
  if (!(permissions.all || permissions[permission])) {
    return {
      error: jsonResponse({ error: "Unauthorized. Please log in again." }, 401),
    };
  }

  return {
    actor: {
      id: env.__actorId,
      email: env.__actorEmail || "",
      permissions,
    },
  };
}

export function adminRequiredPermission(pathname) {
  return requiredPermission(pathname, "admin");
}
