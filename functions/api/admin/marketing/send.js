import { runQuery, jsonResponse } from "../../../_lib/db.js";
import { requireAdmin } from "../../../_lib/auth.js";
import { sendEmail } from "../../../_lib/email.js";
import { sanitizeText } from "../../../_lib/security.js";

const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
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

    const files = form
      .getAll("images")
      .filter((value) => value instanceof File && value.size > 0);
    if (files.length > MAX_ATTACHMENTS)
      return jsonResponse(
        { error: `Attach no more than ${MAX_ATTACHMENTS} images.` },
        400,
      );

    const attachments = [];
    for (const file of files) {
      if (!file.type.startsWith("image/") || file.size > MAX_ATTACHMENT_BYTES) {
        return jsonResponse(
          { error: "Attachments must be images no larger than 5 MB each." },
          400,
        );
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      attachments.push({ filename: file.name, content: btoa(binary) });
    }

    const subscribers = await runQuery(
      env,
      `
      SELECT email FROM customers
      WHERE marketing_email_opt_in = TRUE AND email IS NOT NULL AND email <> '';
    `,
    );
    let sent = 0;
    const failures = [];
    for (const subscriber of subscribers.rows) {
      try {
        await sendEmail(env, {
          to: subscriber.email,
          subject,
          html: escapeHtml(body).replaceAll("\n", "<br>"),
          attachments,
        });
        sent += 1;
      } catch (error) {
        failures.push({ email: subscriber.email, error: error.message });
      }
    }

    return jsonResponse(
      {
        success: failures.length === 0,
        subscribers: subscribers.rows.length,
        sent,
        failed: failures.length,
        failures: failures.slice(0, 10),
      },
      failures.length === 0 ? 200 : 502,
    );
  } catch (error) {
    return jsonResponse(
      { error: "Failed to send marketing email.", message: error.message },
      500,
    );
  }
}
