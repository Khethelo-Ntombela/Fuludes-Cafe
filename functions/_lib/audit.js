/**
 * functions/_lib/audit.js
 * -----------------------------------------------------------------------
 * Audit logging helper for security-sensitive actions and payment events.
 * -----------------------------------------------------------------------
 */
import { runQuery } from "./db.js";

export async function logAudit(
  env,
  {
    actor_type = null,
    actor_id = null,
    actor_role = null,
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
  await runQuery(
    env,
    `
    INSERT INTO audit_logs
      (actor_type, actor_id, actor_role, actor_ip, action, target_type, target_id, details, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now());
  `,
    [
      actor_type,
      actor_id,
      actor_role,
      actor_ip,
      action,
      target_type,
      target_id,
      JSON.stringify(details),
    ],
  );
}
