import { runQuery } from "../../_lib/db.js";

// GET /api/auth/verify-email?token=
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const back = (result) => Response.redirect(`${url.origin}/home.html?email_verified=${result}`, 302);
  const token = url.searchParams.get("token") || "";
  if (!token) return back("invalid");

  try {
    const result = await runQuery(
      env,
      "SELECT customer_id, expires_at, used FROM email_verification_tokens WHERE token = $1;",
      [token],
    );
    const verification = result.rows[0];
    if (
      !verification ||
      verification.used ||
      new Date(verification.expires_at) <= new Date()
    ) {
      return back("invalid");
    }

    await runQuery(
      env,
      "UPDATE customers SET is_verified = TRUE WHERE id = $1;",
      [verification.customer_id],
    );
    await runQuery(
      env,
      "UPDATE email_verification_tokens SET used = TRUE WHERE token = $1;",
      [token],
    );
    return back("yes");
  } catch (err) {
    return back("error");
  }
}
