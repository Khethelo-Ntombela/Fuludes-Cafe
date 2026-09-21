/**
 * functions/api/admin/buffet-cleanup.js
 * -----------------------------------------------------------------------
 * Small admin-only endpoint to run a manual cleanup of past buffet
 * bookings. POST JSON { mode: 'archive' | 'delete' } (defaults to 'archive').
 * - 'archive' marks past bookings as `expired` (safer, reversible)
 * - 'delete' permanently removes past booking rows
 * Returns { success: true, mode, affected }
 * -----------------------------------------------------------------------
 */
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { requireAdmin } from "../../_lib/auth.js";

export async function onRequestPost(context) {
  const { request, env } = context;
  const authErr = await requireAdmin(request, env);
  if (authErr) return authErr;
  try {
    const body = await request.json().catch(() => ({}));
    const mode = (
      body.mode ||
      new URL(request.url).searchParams.get("mode") ||
      "archive"
    ).toLowerCase();

    if (mode === "archive") {
      const res = await runQuery(
        env,
        `
        UPDATE buffet_bookings bb
        SET status = 'expired'
        FROM buffet_events be
        WHERE bb.event_id = be.id
          AND bb.status NOT IN ('cancelled','expired')
          AND be.event_date < now()
        RETURNING bb.id;
      `,
        [],
      );
      return jsonResponse({
        success: true,
        mode: "archive",
        affected: (res.rows || []).length,
      });
    }

    if (mode === "delete") {
      const res = await runQuery(
        env,
        `
        DELETE FROM buffet_bookings
        USING buffet_events
        WHERE buffet_bookings.event_id = buffet_events.id
          AND buffet_events.event_date < now()
        RETURNING buffet_bookings.id;
      `,
        [],
      );
      return jsonResponse({
        success: true,
        mode: "delete",
        affected: (res.rows || []).length,
      });
    }

    return jsonResponse(
      { error: 'Unknown mode. Use "archive" or "delete".' },
      400,
    );
  } catch (err) {
    return jsonResponse({ error: "Cleanup failed", message: err.message }, 500);
  }
}
