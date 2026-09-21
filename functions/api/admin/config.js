/**
 * functions/api/admin/config.js
 * -----------------------------------------------------------------------
 * POST /api/admin/config  { is_buffet_visible: true|false }
 * Flips the single-row app_config used to show/hide the buffet section
 * on the live customer site instantly.
 * -----------------------------------------------------------------------
 */
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { requireAdmin } from "../../_lib/auth.js";
import { sanitizeText } from "../../_lib/security.js";

export async function onRequestPost(context) {
  const { request, env } = context;
  const authError = await requireAdmin(request, env);
  if (authError) return authError;

  try {
    const body = await request.json();
    const is_buffet_visible = !!body.is_buffet_visible;
    const is_out_of_service = !!body.is_out_of_service;
    const out_of_service_reason = sanitizeText(
      body.out_of_service_reason || "",
      400,
    );
    await runQuery(
      env,
      "UPDATE app_config SET is_buffet_visible = $1, is_out_of_service = $2, out_of_service_reason = $3 WHERE id = 1;",
      [is_buffet_visible, is_out_of_service, out_of_service_reason || null],
    );
    return jsonResponse({
      success: true,
      is_buffet_visible,
      is_out_of_service,
      out_of_service_reason: out_of_service_reason || null,
    });
  } catch (err) {
    return jsonResponse(
      { error: "Failed to update config.", message: err.message },
      500,
    );
  }
}
