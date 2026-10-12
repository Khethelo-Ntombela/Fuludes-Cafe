// GET  /api/admin/delivery-fee
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { requireAdmin } from "../../_lib/auth.js";
import { MAX_DELIVERY_KM } from "../../_lib/delivery.js";
import { sanitizeText, isValidEmail, normalizePhone, VALIDATION_MESSAGES } from "../../_lib/security.js";
import { logAudit, money } from "../../_lib/audit.js";
import { getRequestIp } from "../../_lib/security.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const authError = await requireAdmin(request, env);
  if (authError) return authError;

  try {
    const [bandsRes, configRes] = await Promise.all([
      // Bands beyond the delivery limit (36 km) are no longer used, so they aren't shown.
      runQuery(env, `SELECT id, up_to_km, fee, sort_order FROM delivery_fee_bands WHERE up_to_km <= $1 ORDER BY sort_order;`, [MAX_DELIVERY_KM]),
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

  if (cafe_latitude != null && cafe_latitude !== "" && !(Math.abs(parseFloat(cafe_latitude)) <= 90)) {
    return jsonResponse({ error: "Latitude must be between -90 and 90." }, 400);
  }
  if (cafe_longitude != null && cafe_longitude !== "" && !(Math.abs(parseFloat(cafe_longitude)) <= 180)) {
    return jsonResponse({ error: "Longitude must be between -180 and 180." }, 400);
  }
  // Shown to customers as typed (e.g. "+27 66 364 9016") - just make sure it's a real number.
  if (cafe_phone && !normalizePhone(sanitizeText(cafe_phone, 50))) {
    return jsonResponse({ error: VALIDATION_MESSAGES.phone }, 400);
  }
  if (cafe_email && !isValidEmail(sanitizeText(cafe_email, 200))) {
    return jsonResponse({ error: VALIDATION_MESSAGES.email }, 400);
  }
  if (Array.isArray(bands) && bands.some((b) => typeof b.fee === "number" && (b.fee < 0 || b.fee > 10000))) {
    return jsonResponse({ error: "Delivery fees must be between R0 and R10 000." }, 400);
  }

  try {
    // Snapshot the "before" values so the audit log can show exactly what changed.
    const [beforeBandsRes, beforeCfgRes] = await Promise.all([
      runQuery(env, `SELECT id, up_to_km, fee FROM delivery_fee_bands ORDER BY sort_order;`),
      runQuery(env, `SELECT cafe_latitude, cafe_longitude, cafe_phone, cafe_email FROM app_config WHERE id = 1;`),
    ]);
    const beforeBands = Object.fromEntries((beforeBandsRes.rows || []).map((b) => [b.id, b]));
    const beforeCfg = beforeCfgRes.rows[0] || {};
    const bandLabel = (b) => (b && b.up_to_km != null ? `Up to ${Number(b.up_to_km)} km` : "Band");

    const feeChanges = [];
    // Update fee bands (only fee is editable, up_to_km and sort_order are fixed)
    if (Array.isArray(bands)) {
      for (const band of bands) {
        if (typeof band.id === "number" && typeof band.fee === "number" && band.fee >= 0) {
          const old = beforeBands[band.id];
          if (old && Number(old.fee) !== band.fee) {
            feeChanges.push({ label: bandLabel(old), from: money(old.fee), to: money(band.fee) });
          }
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
    const cfgChanges = [];
    let paramIdx = 1;
    const track = (col, label, value, oldValue) => {
      updates.push(`${col} = $${paramIdx++}`);
      params.push(value);
      const a = oldValue == null || oldValue === "" ? "none" : String(oldValue);
      const b = value == null || value === "" ? "none" : String(value);
      if (a !== b) cfgChanges.push({ label, from: a, to: b });
    };

    if (cafe_latitude != null) track("cafe_latitude", "Cafe latitude", parseFloat(cafe_latitude), beforeCfg.cafe_latitude != null ? parseFloat(beforeCfg.cafe_latitude) : null);
    if (cafe_longitude != null) track("cafe_longitude", "Cafe longitude", parseFloat(cafe_longitude), beforeCfg.cafe_longitude != null ? parseFloat(beforeCfg.cafe_longitude) : null);
    if (cafe_phone != null) track("cafe_phone", "Cafe phone", sanitizeText(cafe_phone, 50), beforeCfg.cafe_phone);
    if (cafe_email != null) track("cafe_email", "Cafe email", sanitizeText(cafe_email, 200), beforeCfg.cafe_email);

    if (updates.length > 0) {
      await runQuery(
        env,
        `UPDATE app_config SET ${updates.join(", ")} WHERE id = 1;`,
        params
      );
    }

    const auditBase = { actor_type: "admin", actor_role: "admin", actor_ip: requestIp };
    if (feeChanges.length) {
      await logAudit(env, {
        ...auditBase,
        action: "delivery_fee_updated",
        target_type: "delivery_fee_bands",
        details: {
          summary: "Delivery fee changed: " + feeChanges.map((c) => `${c.label} ${c.from} → ${c.to}`).join("; "),
          changes: feeChanges,
        },
      });
    }
    if (cfgChanges.length) {
      await logAudit(env, {
        ...auditBase,
        action: "cafe_details_updated",
        target_type: "app_config",
        details: {
          summary: "Cafe location/contact changed: " + cfgChanges.map((c) => `${c.label} ${c.from} → ${c.to}`).join("; "),
          changes: cfgChanges,
        },
      });
    }

    return jsonResponse({ success: true });
  } catch (err) {
    return jsonResponse(
      { error: "Failed to update delivery fee settings.", message: err.message },
      500
    );
  }
}