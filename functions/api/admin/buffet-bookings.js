// Admin endpoints to list and update buffet bookings
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { requireAdmin } from "../../_lib/auth.js";
import { queuePush } from "../../_lib/push.js";
import { isValidEmail, isValidName, normalizePhone, VALIDATION_MESSAGES } from "../../_lib/security.js";

/** Lets a signed-in customer know their buffet booking was confirmed/cancelled. */
async function pushBookingStatus(context, bookingId, status) {
  const result = await runQuery(
    context.env,
    "SELECT bb.customer_id, be.title FROM buffet_bookings bb JOIN buffet_events be ON be.id = bb.event_id WHERE bb.id = $1;",
    [bookingId],
  ).catch(() => ({ rows: [] }));
  const row = result.rows[0];
  if (!row?.customer_id) return;
  queuePush(context, { customerId: row.customer_id }, {
    title: `Buffet booking ${status}`,
    body: `Your booking for "${row.title}" is ${status}.`,
    url: "/home.html",
    tag: `buffet-${bookingId}`,
  });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const authErr = await requireAdmin(request, env);
  if (authErr) return authErr;
  try {
    const params = new URL(request.url).searchParams;
    const event_id = params.get("event_id");
    let res;
    if (event_id) {
      res = await runQuery(
        env,
        "SELECT id, event_id, customer_id, name, email, phone, seats, status, created_at FROM buffet_bookings WHERE event_id = $1 ORDER BY created_at DESC;",
        [Number(event_id)],
      );
    } else {
      res = await runQuery(
        env,
        "SELECT id, event_id, customer_id, name, email, phone, seats, status, created_at FROM buffet_bookings ORDER BY created_at DESC LIMIT 200;",
        [],
      );
    }
    return jsonResponse({ bookings: res.rows });
  } catch (err) {
    return jsonResponse(
      { error: "Failed to list bookings.", message: err.message },
      500,
    );
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const authErr = await requireAdmin(request, env);
  if (authErr) return authErr;
  try {
    const body = await request.json();

    if (body.action === "create") {
      const event_id = Number(body.event_id);
      const name = String(body.name || "").replace(/[<>]/g, "").trim().slice(0, 100);
      const phoneInput = String(body.phone || "").replace(/[<>]/g, "").trim().slice(0, 50);
      const phone = normalizePhone(phoneInput) || "";
      const email = String(body.email || "").replace(/[<>]/g, "").trim().toLowerCase().slice(0, 100);
      const seats = Math.max(1, parseInt(body.seats, 10) || 0);
      if (name && !isValidName(name)) return jsonResponse({ error: VALIDATION_MESSAGES.name }, 400);
      if (phoneInput && !phone) return jsonResponse({ error: VALIDATION_MESSAGES.phone }, 400);
      if (email && !isValidEmail(email)) return jsonResponse({ error: VALIDATION_MESSAGES.email }, 400);
      if (seats > 500) return jsonResponse({ error: "That's more seats than any event holds." }, 400);
      if (!event_id || !name || !phone || !seats) {
        return jsonResponse({ error: "Event, name, phone and number of seats are required." }, 400);
      }
      const evt = await runQuery(env, "SELECT id, capacity FROM buffet_events WHERE id = $1;", [event_id]);
      if (!evt.rows.length) return jsonResponse({ error: "Buffet event not found." }, 404);
      const taken = await runQuery(
        env,
        "SELECT COALESCE(SUM(seats),0) AS taken FROM buffet_bookings WHERE event_id = $1 AND status IN ('pending','confirmed');",
        [event_id],
      );
      const left = Number(evt.rows[0].capacity || 0) - Number(taken.rows[0].taken || 0);
      if (seats > left) {
        return jsonResponse({ error: `Only ${Math.max(left, 0)} seat${left === 1 ? "" : "s"} left for this event.` }, 400);
      }
      let customer_id = null;
      if (email) {
        const c = await runQuery(env, "SELECT id FROM customers WHERE email = $1;", [email]);
        customer_id = c.rows[0]?.id || null;
      }
      const ins = await runQuery(
        env,
        "INSERT INTO buffet_bookings (event_id, customer_id, name, email, phone, seats, status) VALUES ($1,$2,$3,$4,$5,$6,'confirmed') RETURNING id;",
        [event_id, customer_id, name, email, phone, seats],
      );
      return jsonResponse({ success: true, booking_id: ins.rows[0].id, seats_left: left - seats }, 201);
    }

    const booking_id = Number(body.booking_id);
    const action = body.action;
    if (!booking_id || !action)
      return jsonResponse({ error: "Missing booking_id or action" }, 400);
    if (action === "cancel") {
      await runQuery(
        env,
        "UPDATE buffet_bookings SET status='cancelled' WHERE id=$1;",
        [booking_id],
      );
      await pushBookingStatus(context, booking_id, "cancelled");
      return jsonResponse({ success: true });
    }
    if (action === "confirm") {
      await runQuery(
        env,
        "UPDATE buffet_bookings SET status='confirmed' WHERE id=$1;",
        [booking_id],
      );
      await pushBookingStatus(context, booking_id, "confirmed");
      return jsonResponse({ success: true });
    }
    return jsonResponse({ error: "Unknown action" }, 400);
  } catch (err) {
    return jsonResponse(
      { error: "Failed to update booking.", message: err.message },
      500,
    );
  }
}
