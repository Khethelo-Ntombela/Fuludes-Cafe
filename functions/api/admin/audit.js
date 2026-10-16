import { requireAdmin } from "../../_lib/auth.js";
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { logAudit } from "../../_lib/audit.js";
import { getRequestIp } from "../../_lib/security.js";

// DELETE /api/admin/audit { confirm: "CLEAR" } Permanently wipes the audit log
async function clearAuditLog(request, env) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    /* handled below */
  }
  if (body.confirm !== "CLEAR") {
    return jsonResponse({ error: "Clearing the audit log must be confirmed." }, 400);
  }
  const deleted = (await runQuery(env, "WITH d AS (DELETE FROM audit_logs RETURNING 1) SELECT COUNT(*)::int AS n FROM d;")).rows[0]?.n ?? 0;
  await logAudit(env, {
    actor_ip: getRequestIp(request),
    action: "audit_log_cleared",
    target_type: "audit_logs",
    details: { entries_deleted: deleted },
  });
  return jsonResponse({ success: true, deleted });
}

export async function onRequest(context) {
  const { request, env } = context;
  const authErr = await requireAdmin(request, env);
  if (authErr) return authErr;
  if (request.method === "DELETE") return clearAuditLog(request, env);

  const url = new URL(request.url);
  const p = url.searchParams;
  const clauses = [];
  const params = [];
  let i = 1;

  if (p.get("from")) {
    clauses.push(`a.created_at >= $${i++}`);
    params.push(p.get("from"));
  }
  if (p.get("to")) {
    clauses.push(`a.created_at <= $${i++}`);
    params.push(p.get("to"));
  }
  if (p.get("actor_role")) {
    clauses.push(`a.actor_role = $${i++}`);
    params.push(p.get("actor_role"));
  }
  if (p.get("action")) {
    clauses.push(`a.action = $${i++}`);
    params.push(p.get("action"));
  }
  if (p.get("actor_id")) {
    clauses.push(`a.actor_id = $${i++}`);
    params.push(Number(p.get("actor_id")));
  }
  if (p.get("target_type")) {
    clauses.push(`a.target_type = $${i++}`);
    params.push(p.get("target_type"));
  }

  const limit = Math.min(200, Number(p.get("limit") || 100));
  const offset = Math.max(0, Number(p.get("offset") || 0));

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  // Make sure the columns the names come from exist (older databases may not have them yet)
  await runQuery(env, "ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS actor_name TEXT;").catch(() => {});
  await runQuery(env, "ALTER TABLE admin_accounts ADD COLUMN IF NOT EXISTS username TEXT;").catch(() => {});

  // actor_name is the name recorded when the action happened. Older entries (and customers, whose
  // names are not recorded) fall back to the account's current name, so nobody shows as just "#1".
  const withNames = `
    SELECT a.id, a.actor_type, a.actor_id, a.actor_role,
           COALESCE(
             NULLIF(a.actor_name, ''),
             CASE a.actor_type
               WHEN 'admin' THEN COALESCE(NULLIF(ad.username, ''), ad.email)
               WHEN 'staff' THEN st.name
               WHEN 'customer' THEN cu.name
             END
           ) AS actor_name,
           a.actor_ip, a.action, a.target_type, a.target_id, a.details, a.created_at
    FROM audit_logs a
    LEFT JOIN admin_accounts ad ON a.actor_type = 'admin' AND ad.id = a.actor_id
    LEFT JOIN staff_accounts st ON a.actor_type = 'staff' AND st.id = a.actor_id
    LEFT JOIN customers cu ON a.actor_type = 'customer' AND cu.id = a.actor_id
    ${where}
    ORDER BY a.created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  const plain = `
    SELECT a.id, a.actor_type, a.actor_id, a.actor_role, a.actor_name,
           a.actor_ip, a.action, a.target_type, a.target_id, a.details, a.created_at
    FROM audit_logs a
    ${where}
    ORDER BY a.created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  let result;
  try {
    result = await runQuery(env, withNames, params);
  } catch {
    // A lookup table (for example staff_accounts) does not exist yet: still show the log
    result = await runQuery(env, plain, params);
  }
  return jsonResponse({ rows: result.rows });
}
