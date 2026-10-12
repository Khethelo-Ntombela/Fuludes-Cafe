// Customer-facing endpoints to view and cancel their buffet bookings
import { runQuery, jsonResponse } from "../_lib/db.js";
import { requireCustomer } from "../_lib/customerAuth.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  // Archive past bookings so customers don't see events that already happened
  await runQuery(env, `
    UPDATE buffet_bookings bb
    SET status = 'expired'
    FROM buffet_events be
    WHERE bb.event_id = be.id
      AND bb.status NOT IN ('cancelled','expired')
      AND be.event_date < now();
  `, []);
  const maybe = await requireCustomer(request, env);
  if (maybe.error) return maybe.error;
  const { customer } = maybe;
  try {
    const res = await runQuery(env, `
      SELECT bb.id AS booking_id, bb.event_id, bb.seats, bb.status, bb.created_at,
             be.title, be.event_date, be.capacity, be.price_cents,
             COALESCE((SELECT SUM(seats) FROM buffet_bookings bb2 WHERE bb2.event_id = be.id AND bb2.status IN ('pending','confirmed')),0) AS seats_taken
      FROM buffet_bookings bb
      JOIN buffet_events be ON be.id = bb.event_id
      WHERE (bb.customer_id = $1 OR LOWER(bb.email) = LOWER($2)) AND be.event_date >= now() AND bb.status != 'expired'
      ORDER BY be.event_date ASC;
    `, [customer.id, customer.email || '']);

    const bookings = res.rows.map(r => ({
      booking_id: r.booking_id,
      event_id: r.event_id,
      seats: Number(r.seats),
      status: r.status,
      created_at: r.created_at,
      title: r.title,
      event_date: r.event_date,
      capacity: Number(r.capacity || 0),
      price_cents: Number(r.price_cents || 0),
      seats_taken: Number(r.seats_taken || 0),
      seats_remaining: Number(r.capacity || 0) - Number(r.seats_taken || 0)
    }));

    return jsonResponse({ bookings });
  } catch (err) {
    return jsonResponse({ error: 'Failed to load your bookings.', message: err.message }, 500);
  }
}

export async function onRequestPut(context) {
  const { request, env } = context;
  // Archive past bookings before processing cancels
  await runQuery(env, `
    UPDATE buffet_bookings bb
    SET status = 'expired'
    FROM buffet_events be
    WHERE bb.event_id = be.id
      AND bb.status NOT IN ('cancelled','expired')
      AND be.event_date < now();
  `, []);
  const maybe = await requireCustomer(request, env);
  if (maybe.error) return maybe.error;
  const { customer } = maybe;
  try {
    const body = await request.json();
    const booking_id = Number(body.booking_id);
    if (!booking_id) return jsonResponse({ error: 'Missing booking_id' }, 400);

    // Verify booking belongs to customer and is cancelable
    const q = await runQuery(env, `
      SELECT bb.id, bb.event_id, bb.status, be.event_date, be.booking_closes_at
      FROM buffet_bookings bb
      JOIN buffet_events be ON be.id = bb.event_id
      WHERE bb.id = $1 AND (bb.customer_id = $2 OR LOWER(bb.email) = LOWER($3))
      LIMIT 1;
    `, [booking_id, customer.id, customer.email || '']);
    if (!q.rows.length) return jsonResponse({ error: 'Booking not found' }, 404);
    const row = q.rows[0];
    if (row.status === 'cancelled' || row.status === 'expired') return jsonResponse({ error: 'Booking already cancelled or expired' }, 400);
    // Cancellation deadline: booking_closes_at if set, otherwise event_date
    const now = new Date();
    if (row.booking_closes_at && new Date(row.booking_closes_at) <= now) return jsonResponse({ error: 'Booking cancellation window has closed' }, 400);
    if (!row.booking_closes_at && new Date(row.event_date) <= now) return jsonResponse({ error: 'Cannot cancel past events' }, 400);

    await runQuery(env, "UPDATE buffet_bookings SET status='cancelled' WHERE id=$1;", [booking_id]);
    return jsonResponse({ success: true });
  } catch (err) {
    return jsonResponse({ error: 'Failed to cancel booking.', message: err.message }, 500);
  }
}
