/**
 * functions/_lib/email.js
 * -----------------------------------------------------------------------
 * Minimal wrapper around Resend's HTTP API (https://resend.com) for
 * transactional email - currently only used for password reset links
 * (functions/api/auth/forgot-password.js). Resend's free tier covers this
 * comfortably (100 emails/day) for a single cafe's traffic, keeping the
 * project at R0/month like everything else.
 *
 * Needs RESEND_API_KEY and RESEND_FROM_EMAIL set in the environment - see
 * README section 2.5. RESEND_FROM_EMAIL must be an address on a domain
 * you've verified with Resend (or their shared onboarding domain while
 * testing).
 * -----------------------------------------------------------------------
 */
export async function sendEmail(env, { to, subject, html, attachments = [] }) {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL) {
    throw new Error("Email sending isn't configured on the server yet.");
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.RESEND_FROM_EMAIL,
      to,
      subject,
      html,
      ...(attachments.length > 0 ? { attachments } : {}),
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Resend rejected the email (HTTP ${res.status}): ${body}`);
  }
}

/**
 * Sends many separate emails with Resend's batch endpoint (up to 100 per
 * request) - one request per 100 recipients instead of one each, which
 * keeps a newsletter inside Cloudflare's per-request limits.
 * emails: [{ to, subject, html }]. Returns { sent, failures: [{ email, error }] }.
 */
export async function sendEmailBatch(env, emails) {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL) {
    throw new Error("Email sending isn't configured on the server yet.");
  }
  let sent = 0;
  const failures = [];
  for (let i = 0; i < emails.length; i += 100) {
    const chunk = emails.slice(i, i + 100);
    const res = await fetch("https://api.resend.com/emails/batch", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(chunk.map((e) => ({ from: env.RESEND_FROM_EMAIL, to: e.to, subject: e.subject, html: e.html }))),
    });
    if (res.ok) {
      sent += chunk.length;
    } else {
      const body = await res.text().catch(() => "");
      const error = `Resend rejected the batch (HTTP ${res.status}): ${body}`.slice(0, 300);
      for (const e of chunk) failures.push({ email: e.to, error });
    }
  }
  return { sent, failures };
}
