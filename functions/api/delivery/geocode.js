// POST /api/delivery/geocode
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

/** query: free text, or { street, city, state, postalcode } for LocationIQ's structured search. */
async function search(apiKey, query, box) {
  const params = new URLSearchParams({
    key: apiKey,
    format: "json",
    limit: "5",
    countrycodes: "za",
    addressdetails: "1",
  });
  if (typeof query === "string") params.set("q", query);
  else {
    for (const [k, v] of Object.entries(query)) if (v) params.set(k, v);
    params.set("country", "South Africa");
  }
  if (box) {
    params.set("viewbox", `${box.west},${box.north},${box.east},${box.south}`);
    params.set("bounded", "1");
  }
  const doFetch = () =>
    fetch(`${LOCATIONIQ_BASE}?${params.toString()}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(6000), // never leave checkout stuck on "Calculating"
    });
  let res = await doFetch();
  if (res.status === 429) {
    // Free LocationIQ keys allow ~2 requests/second; our fallbacks can trip that.
    await new Promise((r) => setTimeout(r, 1100));
    res = await doFetch();
  }
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

// Shared phone location -> address parts for the checkout fields
async function reverseGeocode(apiKey, lat, lng) {
  const params = new URLSearchParams({ key: apiKey, lat: String(lat), lon: String(lng), format: "json", addressdetails: "1" });
  try {
    const res = await fetch(`${LOCATIONIQ_BASE.replace("/search", "/reverse")}?${params.toString()}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return { lat, lng, display_name: "", address: {} };
    const data = await res.json();
    const a = data.address || {};
    return {
      lat,
      lng,
      display_name: data.display_name || "",
      address: {
        street: [a.house_number, a.road].filter(Boolean).join(" "),
        suburb: a.suburb || a.neighbourhood || a.village || a.hamlet || "",
        city: a.city || a.town || a.municipality || a.county || "",
        postal_code: a.postcode || "",
        province: a.state || "",
      },
    };
  } catch {
    return { lat, lng, display_name: "", address: {} };
  }
}

async function cafeLocation(env) {
  try {
    const cfg = (await runQuery(env, "SELECT cafe_latitude, cafe_longitude FROM app_config WHERE id = 1;")).rows[0];
    if (cfg && cfg.cafe_latitude != null && cfg.cafe_longitude != null) {
      return { lat: parseFloat(cfg.cafe_latitude), lng: parseFloat(cfg.cafe_longitude) };
    }
  } catch {
    /* no cafe location yet */
  }
  return null;
}

function boxAround(cafe) {
  if (!cafe) return null;
  const dLat = BOX_KM / 111;
  const dLng = BOX_KM / (111 * Math.cos((cafe.lat * Math.PI) / 180));
  return { west: cafe.lng - dLng, east: cafe.lng + dLng, north: cafe.lat + dLat, south: cafe.lat - dLat };
}

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// How well a geocoder result matches what the customer typed: street name, postal code, suburb
function scoreResult(r, parts) {
  const hay = ` ${norm(r.display_name)} ${norm(Object.values(r.address || {}).join(" "))} `;
  const has = (v) => {
    const n = norm(v);
    return n.length > 1 && hay.includes(` ${n} `);
  };
  const streetName = norm(parts.street).replace(/^(no |stand |erf )?\d+[a-z]? /, "");
  let score = 0;
  let streetMatched = false;
  // The street's own name ("Mvelaphanda" of "12 Mvelaphanda St") - "St"/"Street" spellings vary.
  const streetWord = streetName.split(" ")[0];
  if (streetWord && streetWord.length >= 3 && hay.includes(` ${streetWord} `)) {
    score += 3;
    streetMatched = true;
  }
  if (parts.postal && norm(r.address?.postcode) === norm(parts.postal)) score += 3;
  else if (has(parts.postal)) score += 2;
  if (has(parts.suburb)) score += 2;
  if (has(parts.city)) score += 2;
  if (has(parts.province)) score += 1;
  return { score, streetMatched };
}

/** Tries the full address, then structured searches, then the area; returns the best-matching place. */
async function geocodeParts(env, apiKey, parts) {
  const cafe = await cafeLocation(env);
  const box = boxAround(cafe);
  const join = (...xs) => xs.filter(Boolean).join(", ");
  const queries = [
    join(parts.unit, parts.street, parts.suburb, parts.city, parts.postal, parts.province, "South Africa"),
    join(parts.street, parts.suburb, parts.city, parts.postal, parts.province, "South Africa"),
    { street: parts.street, city: parts.city, state: parts.province, postalcode: parts.postal },
    { street: parts.street, city: parts.suburb, state: parts.province, postalcode: parts.postal },
    join(parts.suburb, parts.city, parts.postal, parts.province, "South Africa"),
  ].filter((q, i, all) => {
    if (typeof q !== "string") return q.street && q.city;
    return q && all.indexOf(q) === i;
  });

  let best = null;
  for (const q of queries) {
    for (const b of box ? [box, null] : [null]) {
      const results = await search(apiKey, q, b);
      for (const r of results) {
        const lat = parseFloat(r.lat);
        const lng = parseFloat(r.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        const { score, streetMatched } = scoreResult(r, parts);
        const km = cafe ? haversineKm(cafe.lat, cafe.lng, lat, lng) : 0;
        if (!best || score > best.score || (score === best.score && km < best.km)) {
          best = { lat, lng, km, score, streetMatched, display_name: r.display_name };
        }
      }
      if (results.length) break; // found something near the cafe
    }
    // Street plus postal code/suburb/town all matched: that's the place.
    if (best && best.streetMatched && best.score >= 7) break;
  }

  if (!best) {
    return jsonResponse(
      { error: "We couldn't find that address. Please check the street, suburb and town, or use your current location." },
      404,
    );
  }
  return jsonResponse({
    lat: best.lat,
    lng: best.lng,
    display_name: best.display_name,
    // Only the area (not the street) could be found - the fee is for that area.
    approximate: Boolean(parts.street) && !best.streetMatched,
  });
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

async function handlePost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body." }, 400);
  }

  const apiKey = env.LOCATIONIQ_API_KEY;

  // { lat, lng } from the phone's location: look the address up the other way.
  const shareLat = Number(body.lat);
  const shareLng = Number(body.lng);
  if (body.lat != null && body.lng != null && Number.isFinite(shareLat) && Number.isFinite(shareLng)) {
    if (Math.abs(shareLat) > 90 || Math.abs(shareLng) > 180) return jsonResponse({ error: "Invalid location." }, 400);
    if (!apiKey) return jsonResponse({ lat: shareLat, lng: shareLng, display_name: "", address: {} });
    return jsonResponse(await reverseGeocode(apiKey, shareLat, shareLng));
  }

  // Structured address from the checkout / admin form: use every part entered.
  if (body.parts && typeof body.parts === "object") {
    if (!apiKey) return jsonResponse({ error: "Geocoding service not configured." }, 500);
    const clean = (k, n = 120) => sanitizeText(String(body.parts[k] || ""), n);
    const parts = {
      street: clean("street"),
      unit: clean("unit", 60),
      suburb: clean("suburb"),
      city: clean("city"),
      postal: clean("postal", 10),
      province: clean("province", 60),
    };
    if (!parts.street && !parts.suburb && !parts.city) return jsonResponse({ error: "Address is required." }, 400);
    try {
      return await geocodeParts(env, apiKey, parts);
    } catch (err) {
      return jsonResponse(
        { error: err.status === 502 ? "Geocoding service error." : "Failed to geocode address.", message: err.message },
        err.status || 500,
      );
    }
  }

  const rawAddress = sanitizeText(body.address || "", 500);
  if (!rawAddress) {
    return jsonResponse({ error: "Address is required." }, 400);
  }

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
