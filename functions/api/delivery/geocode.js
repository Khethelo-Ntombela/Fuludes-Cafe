/**
 * functions/api/delivery/geocode.js
 * -----------------------------------------------------------------------
 * POST /api/delivery/geocode
 * Proxies LocationIQ forward geocoding so the API key never reaches the browser.
 * Expects: { address: string }
 * Returns: { lat, lng, display_name } or { error }
 * -----------------------------------------------------------------------
 */
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { sanitizeText, getRequestIp } from "../../_lib/security.js";

const LOCATIONIQ_BASE = "https://api.locationiq.com/v1/search";

export async function onRequestPost(context) {
  const { request, env } = context;
  const requestIp = getRequestIp(request);

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

  // Build LocationIQ request
  const params = new URLSearchParams({
    key: apiKey,
    q: rawAddress,
    format: "json",
    limit: "1",
    countrycodes: "za", // bias to South Africa
  });

  try {
    const res = await fetch(`${LOCATIONIQ_BASE}?${params.toString()}`, {
      headers: { "Accept": "application/json" },
    });

    if (!res.ok) {
      const details = await res.text();
      return jsonResponse(
        { error: "Geocoding service error.", details },
        502
      );
    }

    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) {
      return jsonResponse(
        { error: "Could not find that address. Please check and try again." },
        404
      );
    }

    const match = data[0];
    return jsonResponse({
      lat: parseFloat(match.lat),
      lng: parseFloat(match.lon),
      display_name: match.display_name,
    });
  } catch (err) {
    return jsonResponse(
      { error: "Failed to geocode address.", message: err.message },
      500
    );
  }
}