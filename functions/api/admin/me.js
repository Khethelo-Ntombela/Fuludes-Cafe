// GET /api/admin/me
import { jsonResponse } from "../../_lib/db.js";
import { requireAdmin } from "../../_lib/auth.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const authError = await requireAdmin(request, env);
  if (authError) return authError;
  const { __actorId, ...permissions } = env.__actorPermissions || {};
  return jsonResponse({ id: env.__actorId ?? null, permissions });
}
