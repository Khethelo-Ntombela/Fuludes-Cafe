/**
 * functions/_lib/db.js
 * -----------------------------------------------------------------------
 * Tiny wrapper around Neon's HTTP SQL endpoint (`/sql` via the Neon Data
 * API). Every Pages Function imports `runQuery()` instead of hand-rolling
 * fetch() calls, so the request shape and error handling only live in one
 * place.
 *
 * Required environment variables (set in Cloudflare Pages > Settings >
 * Environment variables):
 *   NEON_DATABASE_URL  e.g. https://<project>.neon.tech  (no trailing slash)
 *   NEON_AUTH_TOKEN    the Neon Data API bearer token
 *
 * NOTE: files/folders prefixed with "_" are ignored by Cloudflare Pages'
 * file-based router, so this module is never itself exposed as a route.
 * -----------------------------------------------------------------------
 */

/**
 * Run a single parameterised SQL statement against Neon.
 * @param {object} env - the Pages Function `context.env` object
 * @param {string} query - SQL text with $1, $2... placeholders
 * @param {Array} params - values for the placeholders
 * @returns {Promise<{rows: any[]}>}
 */
export async function runQuery(env, query, params = []) {
  const databaseUrl = env.NEON_DATABASE_URL;
  const databaseToken = env.NEON_AUTH_TOKEN;

  if (!databaseUrl || !databaseToken) {
    throw new DbConfigError("Neon database credentials are missing on the server.");
  }

  const response = await fetch(`${databaseUrl}/v1/sql`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${databaseToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ query, params })
  });

  if (!response.ok) {
    const details = await response.text();
    throw new DbQueryError(`Neon query failed: ${details}`);
  }

  return response.json();
}

/**
 * Run several statements back to back. Neon's HTTP endpoint does not
 * support multi-statement transactions, so this simply awaits each
 * statement in order and stops (returning what succeeded) on failure -
 * callers should design writes so partial completion is safe, or clean
 * up manually (see functions/api/order.js for an example).
 */
export async function runSequence(env, statements) {
  const results = [];
  for (const { query, params } of statements) {
    results.push(await runQuery(env, query, params));
  }
  return results;
}

export class DbConfigError extends Error {}
export class DbQueryError extends Error {}

/** Helper to build a consistent JSON Response. */
export function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      ...extraHeaders
    }
  });
}
