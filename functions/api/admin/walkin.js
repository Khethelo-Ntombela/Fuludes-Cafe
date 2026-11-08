// GET /api/admin/walkin  (open tabs)   POST /api/admin/walkin  (order / close_tab / remove_item / write_off)
import { requireAdmin } from "../../_lib/auth.js";
import { walkinGetHandler, walkinPostHandler } from "../../_lib/walkinApi.js";

export async function onRequestGet(context) {
  const authError = await requireAdmin(context.request, context.env);
  if (authError) return authError;
  return walkinGetHandler(context);
}

export async function onRequestPost(context) {
  const authError = await requireAdmin(context.request, context.env);
  if (authError) return authError;
  return walkinPostHandler(context);
}
