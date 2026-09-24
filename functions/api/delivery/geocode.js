/**
 * functions/api/delivery/geocode.js
 * -----------------------------------------------------------------------
 * POST /api/delivery/geocode   { address: string }
 * Proxies LocationIQ forward geocoding so the API key never reaches the
 * browser. Returns { lat, lng, display_name } or { error }.
 *
 * Why this is smarter than "take the first result": a street address like
 * "12 Main Road" exists in dozens of towns, and the first hit was often a
 * different province - which made nearly every customer come back "too
 * far". Now we:
 *   1. search only inside a box around the cafe first (~55 km each way),
 *   2. retry with the cafe's town/province appended if that finds nothing,
 *   3. only then search all of South Africa,
 * and in every case we return the candidate CLOSEST to the cafe rather than
 * whichever one the geocoder ranked first.
 * -----------------------------------------------------------------------
 */
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { sanitizeText } from "../../_lib/security.js";

const LOCATIONIQ_BASE = "https://api.locationiq.com/v1/search";
const BOX_KM = 55; // half-width of the "near the cafe" search box
const DEFAULT_AREA_HINT = "Thohoyandou, Limpopo, South Africa";

function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

async function search(apiKey, query, box) {
  const params = new URLSearchParams({
    key: apiKey,
    q: query,
    format: "json",
    limit: "5",
    countrycodes: "za",
  });
  if (box) {
    params.set("viewbox", `${box.west},${box.north},${box.east},${box.south}`);
    params.set("bounded", "1");
  }
  const res = await fetch(`${LOCATIONIQ_BASE}?${params.toString()}`, {
    headers: { Accept: "application/json" },
  });
  if (res.status === 404) return []; // LocationIQ answers 404 for "no match"
  if (!res.ok) {
    const details = await res.text().catch(() => "");
    const err = new Error("Geocoding service error.");
    err.details = details;
    err.status = 502;
    throw err;
  }
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

function nearest(results, cafe) {
  let best = null;
  for (const r of results) {
    const lat = parseFloat(r.lat);
    const lng = parseFloat(r.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const km = cafe ? haversineKm(cafe.lat, cafe.lng, lat, lng) : 0;
    if (!best || km < best.km) best = { lat, lng, km, display_name: r.display_name };
  }
  return best;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body." }, 400);
  }

  const rawAddress = sanitizeText(body.address || "", 500);
  if (!rawAddress) {
    return jsonResponse({ error: "Address is required." }, 400);
  }

  const apiKey = env.LOCATIONIQ_API_KEY;
  if (!apiKey) {
    return jsonResponse({ error: "Geocoding service not configured." }, 500);
  }

  try {
    // Where is the cafe? (same coordinates the fee calculation uses)
    let cafe = null;
    try {
      const cfg = (
        await runQuery(
          env,
          "SELECT cafe_latitude, cafe_longitude FROM app_config WHERE id = 1;",
        )
      ).rows[0];
      if (cfg && cfg.cafe_latitude != null && cfg.cafe_longitude != null) {
        cafe = {
          lat: parseFloat(cfg.cafe_latitude),
          lng: parseFloat(cfg.cafe_longitude),
        };
      }
    } catch {
      /* no cafe location yet - fall back to a plain search below */
    }

    let box = null;
    if (cafe) {
      const dLat = BOX_KM / 111;
      const dLng = BOX_KM / (111 * Math.cos((cafe.lat * Math.PI) / 180));
      box = {
        west: cafe.lng - dLng,
        east: cafe.lng + dLng,
        north: cafe.lat + dLat,
        south: cafe.lat - dLat,
      };
    }

    const attempts = [];
    if (box) {
      attempts.push({ q: rawAddress, box });
      attempts.push({ q: `${rawAddress}, ${DEFAULT_AREA_HINT}`, box });
    }
    attempts.push({ q: rawAddress, box: null });
    if (!/south africa/i.test(rawAddress)) {
      attempts.push({ q: `${rawAddress}, South Africa`, box: null });
    }

    for (const attempt of attempts) {
      const results = await search(apiKey, attempt.q, attempt.box);
      const match = nearest(results, cafe);
      if (match) {
        return jsonResponse({
          lat: match.lat,
          lng: match.lng,
          display_name: match.display_name,
        });
      }
    }

    return jsonResponse(
      {
        error:
          "We couldn't find that address. Try adding your suburb or village, e.g. \"Stand 123, Mapate, Thohoyandou\".",
      },
      404,
    );
  } catch (err) {
    return jsonResponse(
      {
        error: err.status === 502 ? "Geocoding service error." : "Failed to geocode address.",
        details: err.details,
        message: err.message,
      },
      err.status || 500,
    );
  }
}
