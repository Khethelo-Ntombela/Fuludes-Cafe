/**
 * functions/_lib/delivery.js
 * Delivery fee calculation shared with the admin "place order for a customer"
 * flow (same rules as the checkout in functions/api/order.js): straight-line
 * distance from the cafe x 1.3 road factor, matched against the fee bands.
 */
import { runQuery } from "./db.js";

const ROAD_BUFFER = 1.3;
const toRad = (deg) => (deg * Math.PI) / 180;

function haversineKm(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

export async function calculateDeliveryFee(env, deliveryLat, deliveryLng) {
  const cfg = (
    await runQuery(env, "SELECT cafe_latitude, cafe_longitude FROM app_config WHERE id = 1;")
  ).rows[0];
  if (!cfg || cfg.cafe_latitude == null || cfg.cafe_longitude == null) {
    return { fee: 0, distance_km: 0, too_far: false };
  }
  const roadKm =
    haversineKm(parseFloat(cfg.cafe_latitude), parseFloat(cfg.cafe_longitude), deliveryLat, deliveryLng) *
    ROAD_BUFFER;
  const bands = (await runQuery(env, "SELECT up_to_km, fee FROM delivery_fee_bands ORDER BY sort_order;")).rows || [];
  const band = bands.find((b) => roadKm <= Number(b.up_to_km));
  const distance_km = Math.round(roadKm * 100) / 100;
  if (!band) return { fee: 0, distance_km, too_far: true };
  return { fee: parseFloat(band.fee), distance_km, too_far: false };
}
