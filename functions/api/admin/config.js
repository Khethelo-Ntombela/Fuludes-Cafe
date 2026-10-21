// POST /api/admin/config
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { requireAdmin } from "../../_lib/auth.js";
import { sanitizeText, getRequestIp } from "../../_lib/security.js";
import { logAudit } from "../../_lib/audit.js";
import { ensureConfigColumns } from "../../_lib/config.js";
import { normalizeHours, validateHoursInput } from "../../_lib/hours.js";

export async function onRequestPost(context) {
  const { request, env } = context;
  const authError = await requireAdmin(request, env);
  if (authError) return authError;

  try {
    const body = await request.json();
    await ensureConfigColumns(env);

    const currentRes = await runQuery(
      env,
      "SELECT is_buffet_visible, is_out_of_service, out_of_service_reason, announcement_message, business_hours FROM app_config WHERE id = 1;",
    );
    const cur = currentRes.rows[0] || {};

    const next = {
      is_buffet_visible: !!cur.is_buffet_visible,
      is_out_of_service: !!cur.is_out_of_service,
      out_of_service_reason: cur.out_of_service_reason || null,
      announcement_message: cur.announcement_message || null,
      business_hours: normalizeHours(cur.business_hours),
    };
    const previousHours = next.business_hours;

    if (body.is_buffet_visible !== undefined) next.is_buffet_visible = !!body.is_buffet_visible;
    if (body.is_out_of_service !== undefined) next.is_out_of_service = !!body.is_out_of_service;
    if (body.out_of_service_reason !== undefined) {
      next.out_of_service_reason = sanitizeText(body.out_of_service_reason || "", 400) || null;
    }
    if (body.announcement_message !== undefined) {
      next.announcement_message = sanitizeText(body.announcement_message || "", 300) || null;
    }

    if (body.business_hours !== undefined) {
      const checked = validateHoursInput(body.business_hours);
      if (checked.error) return jsonResponse({ error: checked.error }, 400);
      next.business_hours = checked.hours;
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
              out_of_service_reason = $3, announcement_message = $4,
              business_hours = $5::jsonb
        WHERE id = 1;`,
      [next.is_buffet_visible, next.is_out_of_service, next.out_of_service_reason, next.announcement_message, JSON.stringify(next.business_hours)],
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

    // Business hours: one audit line listing exactly which days changed
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const describe = (d) => (d.closed ? "Closed" : `${d.open}-${d.close}`);
    const hourChanges = [];
    for (let d = 0; d < 7; d++) {
      const before = previousHours[d];
      const after = next.business_hours[d];
      if (describe(before) !== describe(after)) {
        hourChanges.push({ label: dayNames[d], from: describe(before), to: describe(after) });
      }
    }
    if (hourChanges.length) {
      await log(
        "business_hours_updated",
        `Business hours changed: ${hourChanges.map((c) => `${c.label} ${c.from} to ${c.to}`).join("; ")}.`,
        { changes: hourChanges },
      );
    }

    return jsonResponse({ success: true, ...next });
  } catch (err) {
    return jsonResponse({ error: "Failed to update config.", message: err.message }, 500);
  }
}
