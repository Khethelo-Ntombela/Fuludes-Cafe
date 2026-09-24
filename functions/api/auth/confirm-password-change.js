/**
 * functions/api/auth/confirm-password-change.js
 * -----------------------------------------------------------------------
 * POST /api/auth/confirm-password-change  { token }
 * Redeems the one-time link emailed by change-password.js and only THEN
 * writes the new password hash onto the customer row. Unknown, used or
 * expired tokens change nothing. All sessions are ended afterwards so any
 * device still signed in with the old password has to sign in again.
 * No session is required - the link may be opened on a different device
 * from the one that asked; the secret token is the proof.
 * -----------------------------------------------------------------------
 */
import { runQuery, jsonResponse } from "../../_lib/db.js";

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body." }, 400);
  }

  const token = String(body.token || "").trim();
  if (!token) return jsonResponse({ error: "Missing confirmation token." }, 400);

  try {
    // Claim the token atomically so a link can only ever be used once.
    const claimed = await runQuery(
      env,
      `UPDATE password_change_requests
          SET used = TRUE
        WHERE token = $1 AND used = FALSE AND expires_at > NOW()
        RETURNING customer_id, new_hash, new_salt;`,
      [token],
    );
    const req = claimed.rows[0];
    if (!req) {
      return jsonResponse(
        {
          error:
            "This confirmation link is invalid or has expired. Your password was not changed.",
        },
        400,
      );
    }

    await runQuery(
      env,
      `UPDATE customers
          SET password_hash = $1, password_salt = $2,
              failed_login_attempts = 0, is_locked = FALSE
        WHERE id = $3;`,
      [req.new_hash, req.new_salt, req.customer_id],
    );
    await runQuery(env, "DELETE FROM customer_sessions WHERE customer_id = $1;", [
      req.customer_id,
    ]);

    return jsonResponse({
      success: true,
      message: "Your password has been updated. Please sign in with your new password.",
    });
  } catch (err) {
    return jsonResponse(
      { error: "Failed to confirm the password change.", message: err.message },
      500,
    );
  }
}
