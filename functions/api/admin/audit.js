import { requireAdmin } from "../../_lib/auth.js";
import { runQuery, jsonResponse } from "../../_lib/db.js";

export async function onRequest(context) {
  const { request, env } = context;
  const authErr = await requireAdmin(request, env);
  if (authErr) return authErr;

  const url = new URL(request.url);
  const p = url.searchParams;
  const clauses = [];
  const params = [];
  let i = 1;

  if (p.get("from")) {
    clauses.push(`created_at >= $${i++}`);
    params.push(p.get("from"));
  }
  if (p.get("to")) {
    clauses.push(`created_at <= $${i++}`);
    params.push(p.get("to"));
  }
  if (p.get("actor_role")) {
    clauses.push(`actor_role = $${i++}`);
    params.push(p.get("actor_role"));
  }
  if (p.get("action")) {
    clauses.push(`action = $${i++}`);
    params.push(p.get("action"));
  }
  if (p.get("actor_id")) {
    clauses.push(`actor_id = $${i++}`);
    params.push(Number(p.get("actor_id")));
  }
  if (p.get("target_type")) {
    clauses.push(`target_type = $${i++}`);
    params.push(p.get("target_type"));
  }

  const limit = Math.min(200, Number(p.get("limit") || 100));
  const offset = Math.max(0, Number(p.get("offset") || 0));

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const q = `
    SELECT id, actor_type, actor_id, actor_role, actor_ip, action, target_type, target_id, details, created_at
    FROM audit_logs
    ${where}
    ORDER BY created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  const result = await runQuery(env, q, params);
  return jsonResponse({ rows: result.rows });
}
