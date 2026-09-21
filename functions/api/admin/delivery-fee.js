/**
 * functions/api/admin/delivery-fee.js
 * -----------------------------------------------------------------------
 * GET  /api/admin/delivery-fee     - Get all fee bands + cafe location
 * POST /api/admin/delivery-fee     - Update fee bands (fee only) + cafe location/contact
 * -----------------------------------------------------------------------
 */
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { requireAdmin } from "../../_lib/auth.js";
import { sanitizeText } from "../../_lib/security.js";
import { logAudit } from "../../_lib/audit.js";
import { getRequestIp } from "../../_lib/security.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const authError = await requireAdmin(request, env);
  if (authError) return authError;

  try {
    const [bandsRes, configRes] = await Promise.all([
      runQuery(env, `SELECT id, up_to_km, fee, sort_order FROM delivery_fee_bands ORDER BY sort_order;`),
      runQuery(env, `SELECT cafe_latitude, cafe_longitude, cafe_phone, cafe_email FROM app_config WHERE id = 1;`),
    ]);

    return jsonResponse({
      bands: bandsRes.rows || [],
      config: configRes.rows[0] || {},
    });
  } catch (err) {
    return jsonResponse(
      { error: "Failed to load delivery fee settings.", message: err.message },
      500
    );
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const authError = await requireAdmin(request, env);
  if (authError) return authError;
  const requestIp = getRequestIp(request);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body." }, 400);
  }

  const { bands, cafe_latitude, cafe_longitude, cafe_phone, cafe_email } = body;

  try {
    // Update fee bands (only fee is editable, up_to_km and sort_order are fixed)
    if (Array.isArray(bands)) {
      for (const band of bands) {
        if (typeof band.id === "number" && typeof band.fee === "number" && band.fee >= 0) {
          await runQuery(
            env,
            `UPDATE delivery_fee_bands SET fee = $1, updated_at = NOW() WHERE id = $2;`,
            [band.fee, band.id]
          );
        }
      }
    }

    // Update cafe location and contact
    const updates = [];
    const params = [];
    let paramIdx = 1;

    if (cafe_latitude != null) {
      updates.push(`cafe_latitude = $${paramIdx++}`);
      params.push(parseFloat(cafe_latitude));
    }
    if (cafe_longitude != null) {
      updates.push(`cafe_longitude = $${paramIdx++}`);
      params.push(parseFloat(cafe_longitude));
    }
    if (cafe_phone != null) {
      updates.push(`cafe_phone = $${paramIdx++}`);
      params.push(sanitizeText(cafe_phone, 50));
    }
    if (cafe_email != null) {
      updates.push(`cafe_email = $${paramIdx++}`);
      params.push(sanitizeText(cafe_email, 200));
    }

    if (updates.length > 0) {
      await runQuery(
        env,
        `UPDATE app_config SET ${updates.join(", ")} WHERE id = 1;`,
        params
      );
    }

    await logAudit(env, {
      actor_type: "admin",
      actor_role: "admin",
      actor_ip: requestIp,
      action: "delivery_fee_updated",
      target_type: "delivery_fee_bands",
      details: { bands_count: bands?.length || 0 },
    });

    return jsonResponse({ success: true });
  } catch (err) {
    return jsonResponse(
      { error: "Failed to update delivery fee settings.", message: err.message },
      500
    );
  }
}