/**
 * functions/api/auth/me.js
 * -----------------------------------------------------------------------
 * GET /api/auth/me  (Authorization: Bearer <token>)
 * Checked once on page load so the site knows whether to show the "Sign
 * In / Create Account" state or the logged-in account menu, and again
 * whenever the frontend needs to confirm a stored token is still valid
 * (e.g. an old token left over from before a password reset).
 * -----------------------------------------------------------------------
 */
import { jsonResponse } from "../../_lib/db.js";
import { requireCustomer } from "../../_lib/customerAuth.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const { customer, error } = await requireCustomer(request, env);
  if (error) return error;
  return jsonResponse({ customer });
}
