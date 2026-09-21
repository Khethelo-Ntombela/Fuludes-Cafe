/**
 * functions/api/buffet.js
 * -----------------------------------------------------------------------
 * Public endpoints for buffet events listing and creating bookings.
 * GET  /api/buffet         -> { events: [...] }
 * POST /api/buffet/book    -> { success: true, booking_id }
 * -----------------------------------------------------------------------
 */
import { runQuery, jsonResponse } from "../_lib/db.js";
import { sanitizeText } from "../_lib/security.js";
import { checkRateLimit } from "../_lib/rateLimit.js";

export async function onRequestGet(context) {
  const { env } = context;
  const config = await runQuery(
    env,
    "SELECT is_buffet_visible FROM app_config WHERE id = 1;",
  );
  if (!config.rows[0]?.is_buffet_visible) return jsonResponse({ events: [] });
  // Archive past bookings so public views and seat counts ignore them
  await runQuery(
    env,
    `
    UPDATE buffet_bookings bb
    SET status = 'expired'
    FROM buffet_events be
    WHERE bb.event_id = be.id
      AND bb.status NOT IN ('cancelled','expired')
      AND be.event_date < now();
  `,
    [],
  );
  try {
    const res = await runQuery(
      env,
      `
      SELECT b.id, b.title, b.description, b.event_date, b.capacity, b.price_cents, b.photos,
        b.is_published, b.booking_closes_at,
        COALESCE((SELECT SUM(seats) FROM buffet_bookings bb WHERE bb.event_id = b.id AND bb.status = 'confirmed'), 0) AS seats_taken
      FROM buffet_events b
      WHERE b.event_date >= now() AND b.is_published = TRUE
      ORDER BY b.event_date ASC;`,
      [],
    );

    const events = res.rows.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      event_date: r.event_date,
      capacity: r.capacity,
      price_cents: r.price_cents,
      photos: Array.isArray(r.photos) ? r.photos : [],
      is_published: r.is_published,
      booking_closes_at: r.booking_closes_at,
      seats_taken: Number(r.seats_taken || 0),
      seats_remaining: Number(r.capacity || 0) - Number(r.seats_taken || 0),
    }));
    return jsonResponse({ events });
  } catch (err) {
    return jsonResponse(
      { error: "Failed to load buffet events.", message: err.message },
      500,
    );
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const config = await runQuery(
    env,
    "SELECT is_buffet_visible FROM app_config WHERE id = 1;",
  );
  if (!config.rows[0]?.is_buffet_visible)
    return jsonResponse(
      { error: "Buffet bookings are currently unavailable." },
      503,
    );
  // booking POST path: /api/buffet/book will be routed here (check routing)
  try {
    const body = await request.json();
    const event_id = Number(body.event_id);
    const name = sanitizeText(body.name || "", 200);
    const email = sanitizeText(body.email || "", 200);
    const phone = sanitizeText(body.phone || "", 40);
    const seats = Math.max(1, Math.min(20, Number(body.seats) || 1));

    if (!event_id || !name || !email) {
      return jsonResponse({ error: "Missing required booking fields." }, 400);
    }

    // Simple anti-abuse: rate-limit by IP and by email
    try {
      const ip =
        request.headers.get("CF-Connecting-IP") ||
        request.headers.get("x-forwarded-for") ||
        "unknown";
      const okIp = await checkRateLimit(env, `buffet:ip:${ip}`, 10, 3600); // 10 bookings per hour per IP
      if (!okIp)
        return jsonResponse(
          { error: "Rate limit exceeded (IP). Please try again later." },
          429,
        );
      const okEmail = await checkRateLimit(
        env,
        `buffet:email:${email}`,
        3,
        86400,
      ); // 3 bookings per day per email
      if (!okEmail)
        return jsonResponse(
          { error: "Rate limit exceeded (email). Please try again later." },
          429,
        );
    } catch (e) {
      // if rate limiter fails, continue (fail open)
      console.warn("Rate limit check failed", e);
    }

    // Prevent duplicate bookings by same email for same event (unless previous was cancelled)
    const dup = await runQuery(
      env,
      "SELECT id FROM buffet_bookings WHERE event_id = $1 AND email = $2 AND status != 'cancelled' LIMIT 1;",
      [event_id, email],
    );
    if (dup.rows.length)
      return jsonResponse(
        {
          error:
            "An active booking with this email already exists for this event.",
        },
        409,
      );

    // Load event details and current bookings
    const evt = await runQuery(
      env,
      "SELECT id, capacity, is_published, booking_closes_at FROM buffet_events WHERE id = $1;",
      [event_id],
    );
    if (!evt.rows.length)
      return jsonResponse({ error: "Buffet event not found." }, 404);
    const ev = evt.rows[0];
    if (!ev.is_published)
      return jsonResponse(
        { error: "This event is not open for booking." },
        400,
      );
    if (ev.booking_closes_at && new Date(ev.booking_closes_at) <= new Date())
      return jsonResponse({ error: "Booking for this event has closed." }, 400);
    const capacity = ev.capacity || 0;

    const taken = await runQuery(
      env,
      "SELECT COALESCE(SUM(seats),0) AS taken FROM buffet_bookings WHERE event_id = $1 AND status = 'confirmed';",
      [event_id],
    );
    const takenSeats = Number(taken.rows[0].taken || 0);
    if (takenSeats + seats > capacity) {
      return jsonResponse(
        { error: "Not enough seats available for this event." },
        400,
      );
    }

    // Optional: attempt to find logged-in customer via Authorization header
    let customer_id = null;
    try {
      const auth = request.headers.get("Authorization") || "";
      if (auth.startsWith("Bearer ")) {
        const token = auth.slice(7);
        const sess = await runQuery(
          env,
          "SELECT customer_id FROM customer_sessions WHERE token = $1;",
          [token],
        );
        if (sess.rows.length) customer_id = sess.rows[0].customer_id;
      }
    } catch (e) {
      /* ignore */
    }

    // Insert booking as confirmed (UI shows confirmation message; no email)
    const ins = await runQuery(
      env,
      "INSERT INTO buffet_bookings (event_id, customer_id, name, email, phone, seats, status) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id;",
      [event_id, customer_id, name, email, phone || null, seats, "confirmed"],
    );

    return jsonResponse({
      success: true,
      booking_id: ins.rows[0].id,
      message: "Booking confirmed. See you at the event!",
    });
  } catch (err) {
    return jsonResponse(
      { error: "Failed to create booking.", message: err.message },
      500,
    );
  }
}
