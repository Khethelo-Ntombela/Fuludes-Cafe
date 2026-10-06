/**
 * functions/api/delivery/fee.js
 * -----------------------------------------------------------------------
 * POST /api/delivery/fee
 * Calculates delivery fee based on distance from cafe to delivery address.
 * Expects: { lat: number, lng: number }
 * Returns: { fee, distance_km, band_up_to_km, too_far, cafe_phone, cafe_email }
 * -----------------------------------------------------------------------
 */
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { MAX_DELIVERY_KM } from "../../_lib/delivery.js";

const ROAD_BUFFER = 1.3; // straight-line * 1.3 ≈ road distance

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371; // Earth radius in km
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

async function handlePost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body." }, 400);
  }

  const lat = Number(body.lat);
  const lng = Number(body.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return jsonResponse({ error: "Valid lat/lng are required." }, 400);
  }

  try {
    // Get cafe location and fee bands
    const [configRes, bandsRes] = await Promise.all([
      runQuery(
        env,
        `SELECT cafe_latitude, cafe_longitude, cafe_phone, cafe_email
         FROM app_config WHERE id = 1;`
      ),
      runQuery(
        env,
        `SELECT up_to_km, fee, sort_order
         FROM delivery_fee_bands
         ORDER BY sort_order;`
      ),
    ]);

    const config = configRes.rows[0];
    if (!config || config.cafe_latitude == null || config.cafe_longitude == null) {
      return jsonResponse(
        { error: "Cafe location not configured." },
        500
      );
    }

    const cafeLat = parseFloat(config.cafe_latitude);
    const cafeLng = parseFloat(config.cafe_longitude);

    // Calculate straight-line distance and apply road buffer
    const straightKm = haversineKm(cafeLat, cafeLng, lat, lng);
    const roadKm = straightKm * ROAD_BUFFER;

    // Find matching band (first where roadKm <= up_to_km)
    const allBands = bandsRes.rows || [];
    // Only bands inside the delivery limit count - anything further is "too far".
    const bands = allBands.filter((b) => Number(b.up_to_km) <= MAX_DELIVERY_KM);
    if (allBands.length === 0) {
      // Not "too far" - the fee table simply hasn't been set up. Say so
      // instead of turning every customer away.
      return jsonResponse(
        { error: "Delivery fees haven't been set up yet. Please contact the cafe." },
        500
      );
    }
    const matchedBand = bands.find((b) => roadKm <= Number(b.up_to_km));

    if (!matchedBand) {
      // Beyond all bands
      return jsonResponse({
        too_far: true,
        distance_km: Math.round(roadKm * 100) / 100,
        message: "Sorry, you seem far. Please contact us first so we can help you.",
        cafe_phone: config.cafe_phone,
        cafe_email: config.cafe_email,
      });
    }

    return jsonResponse({
      fee: parseFloat(matchedBand.fee), // NUMERIC comes back from Postgres as a string
      distance_km: Math.round(roadKm * 100) / 100,
      band_up_to_km: matchedBand.up_to_km,
      too_far: false,
    });
  } catch (err) {
    return jsonResponse(
      { error: "Failed to calculate delivery fee.", message: err.message },
      500
    );
  }
}
// Never let an unexpected error escape as an HTML error page - the checkout expects JSON.
export async function onRequestPost(context) {
  try {
    return await handlePost(context);
  } catch (err) {
    return jsonResponse({ error: "Delivery lookup failed. Please try again.", message: String(err && err.message) }, 500);
  }
}
// Any other method (e.g. a stray GET) also gets JSON instead of an HTML 404/405 page.
export async function onRequest() {
  return jsonResponse({ error: "Method not allowed." }, 405);
}
