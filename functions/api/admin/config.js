/**
 * functions/api/admin/config.js
 * -----------------------------------------------------------------------
 * POST /api/admin/config   (send only the fields you want to change)
 *   { is_buffet_visible: bool }
 *   { is_out_of_service: bool, out_of_service_reason: string }
 *   { announcement_message: string }
 *
 * Turning Out of Service ON requires a reason - it is shown to customers.
 * Every change is written to the audit log with before -> after values.
 * -----------------------------------------------------------------------
 */
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { requireAdmin } from "../../_lib/auth.js";
import { sanitizeText, getRequestIp } from "../../_lib/security.js";
import { logAudit } from "../../_lib/audit.js";
import { ensureConfigColumns } from "../../_lib/config.js";

export async function onRequestPost(context) {
  const { request, env } = context;
  const authError = await requireAdmin(request, env);
  if (authError) return authError;

  try {
    const body = await request.json();
    await ensureConfigColumns(env);

    const currentRes = await runQuery(
      env,
      "SELECT is_buffet_visible, is_out_of_service, out_of_service_reason, announcement_message FROM app_config WHERE id = 1;",
    );
    const cur = currentRes.rows[0] || {};

    const next = {
      is_buffet_visible: !!cur.is_buffet_visible,
      is_out_of_service: !!cur.is_out_of_service,
      out_of_service_reason: cur.out_of_service_reason || null,
      announcement_message: cur.announcement_message || null,
    };

    if (body.is_buffet_visible !== undefined) next.is_buffet_visible = !!body.is_buffet_visible;
    if (body.is_out_of_service !== undefined) next.is_out_of_service = !!body.is_out_of_service;
    if (body.out_of_service_reason !== undefined) {
      next.out_of_service_reason = sanitizeText(body.out_of_service_reason || "", 400) || null;
    }
    if (body.announcement_message !== undefined) {
      next.announcement_message = sanitizeText(body.announcement_message || "", 300) || null;
    }

    if (next.is_out_of_service && !next.out_of_service_reason) {
      return jsonResponse(
        { error: "Please give a reason for customers (e.g. \"We are closed due to weather conditions\")." },
        400,
      );
    }
    if (!next.is_out_of_service && body.is_out_of_service !== undefined) {
      next.out_of_service_reason = null; // clear the old reason when switching off
    }

    await runQuery(
      env,
      `UPDATE app_config
          SET is_buffet_visible = $1, is_out_of_service = $2,
              out_of_service_reason = $3, announcement_message = $4
        WHERE id = 1;`,
      [next.is_buffet_visible, next.is_out_of_service, next.out_of_service_reason, next.announcement_message],
    );

    // ---- Audit: one clear entry per thing that changed ----
    const ip = getRequestIp(request);
    const log = (action, summary, details) =>
      logAudit(env, {
        actor_type: "admin",
        actor_role: "admin",
        actor_ip: ip,
        action,
        target_type: "app_config",
        details: { summary, ...details },
      });

    if (!!cur.is_out_of_service !== next.is_out_of_service) {
      await log(
        next.is_out_of_service ? "out_of_service_enabled" : "out_of_service_disabled",
        next.is_out_of_service
          ? `Out of service turned ON. Customers see: "${next.out_of_service_reason}"`
          : "Out of service turned OFF. Customers can check out again.",
        { changes: [{ label: "Out of service", from: cur.is_out_of_service ? "ON" : "OFF", to: next.is_out_of_service ? "ON" : "OFF" }], reason: next.out_of_service_reason },
      );
    } else if (next.is_out_of_service && (cur.out_of_service_reason || null) !== next.out_of_service_reason) {
      await log("out_of_service_reason_updated", `Out-of-service reason changed to: "${next.out_of_service_reason}"`, {
        changes: [{ label: "Reason", from: cur.out_of_service_reason || "none", to: next.out_of_service_reason }],
      });
    }

    if ((cur.announcement_message || null) !== next.announcement_message) {
      await log(
        "announcement_updated",
        next.announcement_message
          ? `Hero announcement set to: "${next.announcement_message}"`
          : "Hero announcement removed.",
        { changes: [{ label: "Announcement", from: cur.announcement_message || "none", to: next.announcement_message || "none" }] },
      );
    }

    if (!!cur.is_buffet_visible !== next.is_buffet_visible) {
      await log(
        "buffet_visibility_updated",
        `Buffet section ${next.is_buffet_visible ? "shown on" : "hidden from"} the website.`,
        { changes: [{ label: "Buffet section", from: cur.is_buffet_visible ? "Visible" : "Hidden", to: next.is_buffet_visible ? "Visible" : "Hidden" }] },
      );
    }

    return jsonResponse({ success: true, ...next });
  } catch (err) {
    return jsonResponse({ error: "Failed to update config.", message: err.message }, 500);
  }
}
