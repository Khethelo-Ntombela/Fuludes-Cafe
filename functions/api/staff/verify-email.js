import { runQuery } from "../../_lib/db.js";

/**
 * GET /api/staff/verify-email?token=...  (the link emailed when the main
 * admin creates a new staff account)
 * Always redirects to the main sign-in page (/home?auth=signin&staff_email_verified=yes|invalid|error)
 * rather than returning bare text/JSON, which some phone browsers offer
 * to save as a file instead of showing it.
 */
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const back = (result) => Response.redirect(`${url.origin}/home?auth=signin&staff_email_verified=${result}`, 302);
  const token = url.searchParams.get("token") || "";
  if (!token) return back("invalid");

  try {
    const result = await runQuery(
      env,
      "SELECT staff_id, expires_at, used FROM staff_email_verifications WHERE token = $1;",
      [token],
    );
    const verification = result.rows[0];
    if (!verification || verification.used || new Date(verification.expires_at) <= new Date()) {
      return back("invalid");
    }

    await runQuery(env, "ALTER TABLE staff_accounts ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT TRUE;");
    await runQuery(env, "UPDATE staff_accounts SET email_verified = TRUE WHERE id = $1;", [verification.staff_id]);
    await runQuery(env, "UPDATE staff_email_verifications SET used = TRUE WHERE token = $1;", [token]);
    return back("yes");
  } catch (err) {
    return back("error");
  }
}
