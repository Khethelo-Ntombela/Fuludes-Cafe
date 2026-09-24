/**
 * functions/api/auth/change-password.js
 * -----------------------------------------------------------------------
 * POST /api/auth/change-password  { current_password, new_password }
 * (Authorization: Bearer <customer session token>)
 *
 * Does NOT change the password. It checks the current password, hashes the
 * new one straight away (the plaintext is never stored), parks the hash in
 * `password_change_requests`, and emails the account owner a confirmation
 * link. The password only changes when that link is opened
 * (confirm-password-change.js). If the link is never confirmed - or has
 * expired after 1 hour - the old password keeps working unchanged.
 * -----------------------------------------------------------------------
 */
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { requireCustomer } from "../../_lib/customerAuth.js";
import {
  hashPassword,
  verifyPassword,
  generateToken,
} from "../../_lib/password.js";
import { sendEmail } from "../../_lib/email.js";
import { checkRateLimit } from "../../_lib/rateLimit.js";

const TTL_MS = 60 * 60 * 1000; // 1 hour

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const { customer, error } = await requireCustomer(request, env);
  if (error) return error;

  if (!(await checkRateLimit(env, `auth-pwchange:${customer.id}`, 3, 600))) {
    return jsonResponse(
      { error: "Too many password change requests. Please try again in a few minutes." },
      429,
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body." }, 400);
  }

  const currentPassword = body.current_password || "";
  const newPassword = body.new_password || "";

  if (!customer.has_password) {
    return jsonResponse(
      {
        error:
          "This account signs in with Google, so it has no password to change here.",
      },
      400,
    );
  }
  if (!currentPassword || !newPassword) {
    return jsonResponse(
      { error: "Please enter your current password and a new password." },
      400,
    );
  }
  if (newPassword.length < 8) {
    return jsonResponse(
      { error: "New password must be at least 8 characters." },
      400,
    );
  }
  if (newPassword === currentPassword) {
    return jsonResponse(
      { error: "Your new password must be different from the current one." },
      400,
    );
  }

  try {
    const row = (
      await runQuery(
        env,
        "SELECT password_hash, password_salt FROM customers WHERE id = $1;",
        [customer.id],
      )
    ).rows[0];
    const ok =
      row &&
      row.password_hash &&
      (await verifyPassword(currentPassword, row.password_hash, row.password_salt));
    if (!ok) {
      return jsonResponse({ error: "Your current password is incorrect." }, 400);
    }

    // Only one pending change at a time - a newer request replaces older ones.
    await runQuery(
      env,
      "DELETE FROM password_change_requests WHERE customer_id = $1 AND used = FALSE;",
      [customer.id],
    );

    const { hash, salt } = await hashPassword(newPassword);
    const token = generateToken();
    const expiresAt = new Date(Date.now() + TTL_MS).toISOString();
    await runQuery(
      env,
      `INSERT INTO password_change_requests (token, customer_id, new_hash, new_salt, expires_at)
       VALUES ($1, $2, $3, $4, $5);`,
      [token, customer.id, hash, salt, expiresAt],
    );

    const link = `${new URL(request.url).origin}/?confirm_password=${token}`;
    try {
      await sendEmail(env, {
        to: customer.email,
        subject: "Confirm your Fulude's Cafe password change",
        html: `<p>Hi ${escapeHtml(customer.name)},</p>
<p>We received a request to change the password on your Fulude's Cafe account. To confirm it was you, please open this link within 1 hour:</p>
<p><a href="${link}">${link}</a></p>
<p>Your password will <strong>not</strong> change until you open that link. If you didn't ask for this, ignore this email and your current password stays as it is.</p>`,
      });
    } catch (mailErr) {
      // No email, no way to verify - don't leave a dangling request behind.
      await runQuery(
        env,
        "DELETE FROM password_change_requests WHERE token = $1;",
        [token],
      );
      return jsonResponse(
        {
          error:
            "We couldn't send the confirmation email right now. Your password was not changed. Please try again shortly.",
          message: mailErr.message,
        },
        500,
      );
    }

    return jsonResponse({
      success: true,
      message: `We've sent a confirmation link to ${customer.email}. Your password will only change once you open it.`,
    });
  } catch (err) {
    return jsonResponse(
      { error: "Couldn't process this request right now.", message: err.message },
      500,
    );
  }
}
