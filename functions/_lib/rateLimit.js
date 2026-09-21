/**
 * functions/_lib/rateLimit.js
 * -----------------------------------------------------------------------
 * Simple database-backed rate limiting so auth and other sensitive
 * endpoints can reject repeated abuse across Cloudflare Pages' stateless
 * Functions platform.
 * -----------------------------------------------------------------------
 */
import { runQuery } from "./db.js";

export async function checkRateLimit(env, key, limit, windowSeconds = 60) {
  const seconds = Number(windowSeconds) || 60;
  const result = await runQuery(env, `
    INSERT INTO rate_limits (key, count, expires_at, updated_at)
    VALUES ($1, 1, now() + $2 * interval '1 second', now())
    ON CONFLICT (key)
    DO UPDATE SET
      count = CASE WHEN rate_limits.expires_at > now() THEN rate_limits.count + 1 ELSE 1 END,
      expires_at = CASE WHEN rate_limits.expires_at > now() THEN rate_limits.expires_at ELSE now() + $2 * interval '1 second' END,
      updated_at = now()
    RETURNING count;
  `, [key, seconds]);

  const count = result.rows[0]?.count || 0;
  return count <= limit;
}
