/**
 * functions/api/admin/buffet-events.js
 * -----------------------------------------------------------------------
 * Admin CRUD for buffet events.
 * GET    /api/admin/buffet-events      -> list
 * POST   /api/admin/buffet-events      -> create {title,description,event_date,capacity,price_cents}
 * PUT    /api/admin/buffet-events      -> update {id,...}
 * DELETE /api/admin/buffet-events      -> delete {id}
 * -----------------------------------------------------------------------
 */
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { requireAdmin } from "../../_lib/auth.js";
import { sanitizeText } from "../../_lib/security.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const authErr = await requireAdmin(request, env);
  if (authErr) return authErr;
  try {
    const res = await runQuery(
      env,
      "SELECT id, title, description, event_date, capacity, price_cents, photos, is_published, booking_closes_at FROM buffet_events ORDER BY event_date DESC;",
      [],
    );
    return jsonResponse({ events: res.rows });
  } catch (err) {
    return jsonResponse(
      { error: "Failed to list buffet events.", message: err.message },
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
    const title = sanitizeText(body.title || "", 200);
    const description = sanitizeText(body.description || "", 2000);
    const event_date = body.event_date; // expect ISO string
    const capacity = Number(body.capacity) || 30;
    const price_cents = Number(body.price_cents) || 0;
    const photos = Array.isArray(body.photos) ? body.photos.slice(0, 6) : [];
    const is_published = !!body.is_published;
    const booking_closes_at = body.booking_closes_at || null;
    if (!title || !event_date || isNaN(new Date(event_date).getTime()))
      return jsonResponse(
        { error: "Please add a title and a valid event date & time." },
        400,
      );
    if (
      !booking_closes_at ||
      isNaN(new Date(booking_closes_at).getTime())
    )
      return jsonResponse(
        { error: "Please add the date & time booking closes." },
        400,
      );
    const res = await runQuery(
      env,
      "INSERT INTO buffet_events (title,description,event_date,capacity,price_cents,photos,is_published,booking_closes_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id;",
      [
        title,
        description,
        event_date,
        capacity,
        price_cents,
        JSON.stringify(photos),
        is_published,
        booking_closes_at,
      ],
    );
    return jsonResponse({ success: true, id: res.rows[0].id });
  } catch (err) {
    return jsonResponse(
      { error: "Failed to create event.", message: err.message },
      500,
    );
  }
}

export async function onRequestPut(context) {
  const { request, env } = context;
  const authErr = await requireAdmin(request, env);
  if (authErr) return authErr;
  try {
    const body = await request.json();
    const id = Number(body.id);
    if (!id) return jsonResponse({ error: "Missing id" }, 400);
    const title = sanitizeText(body.title || "", 200);
    const description = sanitizeText(body.description || "", 2000);
    const event_date = body.event_date;
    const capacity = Number(body.capacity) || 30;
    const price_cents = Number(body.price_cents) || 0;
    const photos = Array.isArray(body.photos) ? body.photos.slice(0, 6) : [];
    const is_published = !!body.is_published;
    const booking_closes_at = body.booking_closes_at || null;
    if (!title || !event_date || isNaN(new Date(event_date).getTime()))
      return jsonResponse(
        { error: "Please add a title and a valid event date & time." },
        400,
      );
    if (
      !booking_closes_at ||
      isNaN(new Date(booking_closes_at).getTime())
    )
      return jsonResponse(
        { error: "Please add the date & time booking closes." },
        400,
      );
    await runQuery(
      env,
      "UPDATE buffet_events SET title=$1, description=$2, event_date=$3, capacity=$4, price_cents=$5, photos=$6, is_published=$7, booking_closes_at=$8, updated_at = NOW() WHERE id=$9;",
      [
        title,
        description,
        event_date,
        capacity,
        price_cents,
        JSON.stringify(photos),
        is_published,
        booking_closes_at,
        id,
      ],
    );
    return jsonResponse({ success: true });
  } catch (err) {
    return jsonResponse(
      { error: "Failed to update event.", message: err.message },
      500,
    );
  }
}

export async function onRequestDelete(context) {
  const { request, env } = context;
  const authErr = await requireAdmin(request, env);
  if (authErr) return authErr;
  try {
    const body = await request.json();
    const id = Number(body.id);
    if (!id) return jsonResponse({ error: "Missing id" }, 400);
    await runQuery(env, "DELETE FROM buffet_events WHERE id=$1;", [id]);
    return jsonResponse({ success: true });
  } catch (err) {
    return jsonResponse(
      { error: "Failed to delete event.", message: err.message },
      500,
    );
  }
}
