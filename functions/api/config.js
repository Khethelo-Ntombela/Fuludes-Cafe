/**
 * functions/api/config.js
 * -----------------------------------------------------------------------
 * GET /api/config
 * Public endpoint the customer site polls once on load to know whether
 * admin-controlled display flags (currently just the buffet section)
 * should be shown. Writing to this row is admin-only - see
 * functions/api/admin/config.js.
 * -----------------------------------------------------------------------
 */
import { runQuery, jsonResponse } from "../_lib/db.js";

export async function onRequest(context) {
  if (context.request.method !== "GET") {
    return jsonResponse({ error: "Method not allowed. Use GET." }, 405);
  }
  try {
    const result = await runQuery(context.env, "SELECT is_buffet_visible, is_out_of_service, out_of_service_reason FROM app_config WHERE id = 1;");
    const row = result.rows[0] || { is_buffet_visible: false, is_out_of_service: false, out_of_service_reason: null };
    return jsonResponse(row);
  } catch (err) {
    return jsonResponse({ error: "Failed to load config.", message: err.message }, 500);
  }
}
