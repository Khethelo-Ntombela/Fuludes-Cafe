// POST /api/admin/marketing/send
import { runQuery, jsonResponse } from "../../../_lib/db.js";
import { requireAdmin } from "../../../_lib/auth.js";
import { sendEmailBatch } from "../../../_lib/email.js";
import { sanitizeText } from "../../../_lib/security.js";

const MAX_IMAGES = 5;

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/** Only images we uploaded to our own bucket are allowed into the email. */
function cleanImageUrls(raw, env) {
  let list = [];
  try {
    list = JSON.parse(raw || "[]");
  } catch {
    return [];
  }
  const base = String(env.R2_PUBLIC_URL || "").replace(/\/$/, "");
  return (Array.isArray(list) ? list : [])
    .map((u) => String(u || ""))
    .filter((u) => base && u.startsWith(`${base}/`) && /^https:\/\//.test(u))
    .slice(0, MAX_IMAGES);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const authError = await requireAdmin(request, env);
  if (authError) return authError;

  try {
    const form = await request.formData();
    const subject = sanitizeText(form.get("subject") || "", 200).trim();
    const body = sanitizeText(form.get("body") || "", 10000).trim();
    if (!subject || !body)
      return jsonResponse(
        { error: "Subject and email body are required." },
        400,
      );
    const imageUrls = cleanImageUrls(form.get("image_urls"), env);

    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#111;max-width:600px">
      <p>${escapeHtml(body).replaceAll("\n", "<br>")}</p>
      ${imageUrls
        .map((u) => `<p><img src="${escapeHtml(u)}" alt="" style="display:block;max-width:100%;height:auto;border-radius:8px" /></p>`)
        .join("")}
    </div>`;

    const subscribers = await runQuery(
      env,
      `
      SELECT email FROM customers
      WHERE marketing_email_opt_in = TRUE AND email IS NOT NULL AND email <> '';
    `,
    );
    if (!subscribers.rows.length) {
      return jsonResponse(
        { error: "No customers are subscribed yet - nothing was sent. Customers subscribe under Settings > Account (\"Send me email offers and news\")." },
        400,
      );
    }

    const { sent, failures } = await sendEmailBatch(
      env,
      subscribers.rows.map((s) => ({ to: s.email, subject, html })),
    );

    return jsonResponse(
      {
        success: failures.length === 0,
        subscribers: subscribers.rows.length,
        sent,
        images: imageUrls.length,
        failed: failures.length,
        failures: failures.slice(0, 10),
        error: failures.length ? failures[0].error : undefined,
      },
      failures.length === 0 ? 200 : 502,
    );
  } catch (error) {
    return jsonResponse(
      { error: `Failed to send marketing email: ${error.message}`, message: error.message },
      500,
    );
  }
}
