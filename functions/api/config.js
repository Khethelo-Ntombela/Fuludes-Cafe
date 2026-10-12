// GET /api/config
import { runQuery, jsonResponse } from "../_lib/db.js";
import { ensureConfigColumns } from "../_lib/config.js";

export async function onRequest(context) {
  if (context.request.method !== "GET") {
    return jsonResponse({ error: "Method not allowed. Use GET." }, 405);
  }
  try {
    await ensureConfigColumns(context.env);
    const result = await runQuery(
      context.env,
      "SELECT is_buffet_visible, is_out_of_service, out_of_service_reason, announcement_message FROM app_config WHERE id = 1;",
    );
    const row = result.rows[0] || {};
    const res = jsonResponse({
      is_buffet_visible: !!row.is_buffet_visible,
      is_out_of_service: !!row.is_out_of_service,
      out_of_service_reason: row.out_of_service_reason || null,
      announcement_message: row.announcement_message || null,
    });
    res.headers.set("Cache-Control", "no-store");
    return res;
  } catch (err) {
    return jsonResponse({ error: "Failed to load config.", message: err.message }, 500);
  }
}
