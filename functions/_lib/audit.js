// Audit logging helper for security-sensitive actions and payment events
import { runQuery } from "./db.js";

let auditTableReady = false;
async function ensureActorNameColumn(env) {
  if (auditTableReady) return;
  await runQuery(env, "ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS actor_name TEXT;");
  auditTableReady = true;
}

export async function logAudit(
  env,
  {
    actor_type = null,
    actor_id = null,
    actor_role = null,
    actor_name = null,
    actor_ip = null,
    action,
    target_type = null,
    target_id = null,
    details = {},
  },
) {
  actor_id = actor_id ?? env.__actorId ?? null;
  actor_role = actor_role ?? env.__actorRole ?? null;
  actor_type = actor_type ?? env.__actorRole ?? null;
  // The username/name at the time of the action. It is kept as a fallback (for example if the account is deleted);
  // the audit screen shows the account's current name (see api/admin/audit.js).
  actor_name = actor_name ?? env.__actorName ?? null;
  await ensureActorNameColumn(env);
  await runQuery(
    env,
    `
    INSERT INTO audit_logs
      (actor_type, actor_id, actor_role, actor_name, actor_ip, action, target_type, target_id, details, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now());
  `,
    [
      actor_type,
      actor_id,
      actor_role,
      actor_name,
      actor_ip,
      action,
      target_type,
      target_id,
      JSON.stringify(details),
    ],
  );
}


// Compares two plain objects and returns a readable list of changes
export function diffChanges(before = {}, after = {}, fields = {}) {
  const changes = [];
  for (const [key, meta] of Object.entries(fields)) {
    if (!(key in after)) continue;
    const fmt = meta.format || ((v) => (v === null || v === undefined || v === "" ? "none" : String(v)));
    const a = fmt(before[key]);
    const b = fmt(after[key]);
    if (a !== b) changes.push({ field: key, label: meta.label || key, from: a, to: b });
  }
  return changes;
}

/** "Price: R80.00 → R70.00; Stock: 5 → 3" - the one-line summary shown in the audit log. */
export function summarizeChanges(changes) {
  return changes.map((c) => `${c.label}: ${c.from} → ${c.to}`).join("; ");
}

export const money = (v) =>
  v === null || v === undefined || v === "" ? "none" : `R${Number(v).toFixed(2)}`;
