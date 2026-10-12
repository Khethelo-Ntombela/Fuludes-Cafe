// Tiny wrapper around Neon's serverless PostgreSQL driver

import { neon } from "@neondatabase/serverless";

export async function runQuery(env, query, params = []) {
  const databaseUrl = env.NEON_DATABASE_URL;

  if (!databaseUrl) {
    throw new DbConfigError("Neon database connection is missing on the server.");
  }

  try {
    const sql = neon(databaseUrl);
    const rows = await sql.query(query, params);
    return { rows };
  } catch (error) {
    throw new DbQueryError(`Neon query failed: ${error.message}`);
  }
}

// Run several statements back to back
export async function runSequence(env, statements) {
  const results = [];
  for (const { query, params } of statements) {
    results.push(await runQuery(env, query, params));
  }
  return results;
}

export class DbConfigError extends Error {}
export class DbQueryError extends Error {}

// Anything that looks like a key or connection string is masked before it leaves the server.
const SECRET_PATTERNS = [
  [/postgres(?:ql)?:\/\/[^\s"'\\]+/gi, "[redacted-db-url]"],
  [/\bnpg_[A-Za-z0-9]+/g, "[redacted]"],
  [/\bre_[A-Za-z0-9_]{16,}/g, "[redacted]"],
  [/\bsk_(?:live|test)_[A-Za-z0-9]+/g, "[redacted]"],
  [/\bwhsec_[A-Za-z0-9+/=_-]+/g, "[redacted]"],
  [/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer [redacted]"],
  [/([?&](?:key|api_key|apikey)=)[^&\s"'\\]+/gi, "$1[redacted]"],
];

export function redactSecrets(text) {
  let out = String(text);
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** Helper to build a consistent JSON Response. */
export function jsonResponse(body, status = 200, extraHeaders = {}) {
  let payload = body;
  if (status >= 500 && payload && typeof payload === "object") {
    // Server errors keep their detail in the Cloudflare logs, not in the response.
    const { message, details, ...safe } = payload;
    if (message || details) console.error("API error:", redactSecrets(JSON.stringify({ error: safe.error, message, details })));
    payload = safe;
  }
  return new Response(redactSecrets(JSON.stringify(payload)), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      ...extraHeaders
    }
  });
}
