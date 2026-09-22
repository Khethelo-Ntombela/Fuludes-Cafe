import { runQuery, jsonResponse } from "../../_lib/db.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const token = new URL(request.url).searchParams.get("token") || "";
  if (!token)
    return jsonResponse({ error: "Verification token is required." }, 400);

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
      return jsonResponse(
        { error: "This verification link is invalid or has expired." },
        400,
      );
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
    return new Response("Email verified. You can now sign in.", {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  } catch (err) {
    return jsonResponse(
      { error: "Failed to verify email.", message: err.message },
      500,
    );
  }
}
