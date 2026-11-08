// GET /api/staff/walkin  (open tabs)   POST /api/staff/walkin  (order / close_tab / remove_item)
import { requireStaff } from "../../_lib/auth.js";
import { walkinGetHandler, walkinPostHandler } from "../../_lib/walkinApi.js";

export async function onRequestGet(context) {
  const authError = await requireStaff(context.request, context.env);
  if (authError) return authError;
  return walkinGetHandler(context);
}

export async function onRequestPost(context) {
  const authError = await requireStaff(context.request, context.env);
  if (authError) return authError;
  return walkinPostHandler(context);
}
