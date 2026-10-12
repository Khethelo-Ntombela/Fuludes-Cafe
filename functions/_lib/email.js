// Minimal wrapper around Resend's HTTP API (https://resend.com) for transactional email
// The "From" customers see: "Fulude's Cafe <orders@...>" instead of just the address
function fromAddress(env) {
  const from = String(env.RESEND_FROM_EMAIL || "").trim();
  if (from.includes("<")) return from;
  const name = String(env.EMAIL_FROM_NAME || "Fulude's Cafe").replace(/["\\]/g, "");
  return `"${name}" <${from}>`;
}

// Only the short reason from Resend is kept, never the raw response.
async function resendReason(res) {
  const raw = await res.text().catch(() => "");
  try {
    return String(JSON.parse(raw).message || "unknown error").slice(0, 120);
  } catch {
    return "unknown error";
  }
}

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
      from: fromAddress(env),
      to,
      subject,
      html,
      ...(attachments.length > 0 ? { attachments } : {}),
    }),
  });

  if (!res.ok) {
    throw new Error(`Resend rejected the email (HTTP ${res.status}): ${await resendReason(res)}`);
  }
}

// Sends many separate emails with Resend's batch endpoint (up to 100 per request)
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
      body: JSON.stringify(chunk.map((e) => ({ from: fromAddress(env), to: e.to, subject: e.subject, html: e.html }))),
    });
    if (res.ok) {
      sent += chunk.length;
    } else {
      const error = `Resend rejected the batch (HTTP ${res.status}): ${await resendReason(res)}`;
      for (const e of chunk) failures.push({ email: e.to, error });
    }
  }
  return { sent, failures };
}
