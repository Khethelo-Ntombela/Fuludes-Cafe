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
      error: jsonResponse({ error: "You don't have access to this section.", forbidden: true }, 403),
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
