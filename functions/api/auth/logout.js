// POST /api/auth/logout
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { getRequestIp } from "../../_lib/security.js";

export async function onRequestPost(context) {
  const { request, env } = context;
  const requestIp = getRequestIp(request);
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (!token) {
    return jsonResponse({ success: true });
  }

  try {
    const result = await runQuery(env, "DELETE FROM customer_sessions WHERE token = $1 RETURNING customer_id;", [token]);
    // Do not write customer logout events to audit_logs (audit reserved for admin/staff actions)
    return jsonResponse({ success: true });
  } catch (err) {
    return jsonResponse({ error: "Failed to log out.", message: err.message }, 500);
  }
}
