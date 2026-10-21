// Cafe opening hours (South Africa time) + reservation / collection / delivery slot validation.
//
// The hours are edited by the admin (Settings > General > Business Hours) and stored in
// app_config.business_hours. Every check below takes that schedule as its last argument, so the
// whole site follows whatever the admin saved. DEFAULT_HOURS is only the fallback used before the
// admin has saved anything (or if the database can't be read).
import { runQuery } from "./db.js";
import { ensureConfigColumns } from "./config.js";

// weekday: 0 = Sunday ... 6 = Saturday. `closed: true` means no trading that day.
export const DEFAULT_HOURS = {
  0: { closed: false, open: "09:00", close: "20:00" },
  1: { closed: false, open: "09:00", close: "18:00" },
  2: { closed: false, open: "09:00", close: "18:00" },
  3: { closed: false, open: "09:00", close: "18:00" },
  4: { closed: false, open: "09:00", close: "18:00" },
  5: { closed: false, open: "09:00", close: "20:00" },
  6: { closed: false, open: "09:00", close: "21:00" },
};

export const NOT_OPEN_MESSAGE =
  "Sorry, try a different time because we don't operate at the time you chose.";
export const SLOT_MINUTES = 30; // reservations and chosen collection/delivery times are on the half-hour
export const CLOSED_MESSAGE = "Can't order at this time, we are currently closed.";
export const ORDER_CUTOFF_MINUTES = 60; // online orders stop this long before closing
export const LAST_ORDERS_MESSAGE =
  "Sorry, we've stopped taking online orders for today. Orders close 1 hour before closing time.";
export const OUTSIDE_HOURS_LINK_MESSAGE =
  "You can't generate a payment link right now because it's outside working hours.";

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const toMinutes = (s) => {
  const m = HHMM.exec(String(s || "").trim());
  return m ? +m[1] * 60 + +m[2] : null;
};
const toHHMM = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/**
 * Checks an admin-submitted schedule. Returns { hours } (clean, all 7 days) or { error }.
 */
export function validateHoursInput(raw) {
  if (!raw || typeof raw !== "object") return { error: "Business hours are missing." };
  const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const hours = {};
  for (let d = 0; d < 7; d++) {
    const day = raw[d] ?? raw[String(d)];
    if (!day || typeof day !== "object") return { error: `Business hours for ${names[d]} are missing.` };
    if (day.closed) {
      hours[d] = { closed: true, open: DEFAULT_HOURS[d].open, close: DEFAULT_HOURS[d].close };
      continue;
    }
    const open = toMinutes(day.open);
    const close = toMinutes(day.close);
    if (open === null || close === null) return { error: `Enter a valid opening and closing time for ${names[d]}.` };
    if (close <= open) return { error: `${names[d]}: closing time must be later than opening time.` };
    // Online orders stop an hour before closing - an open window shorter than that could never take an order.
    if (close - open <= ORDER_CUTOFF_MINUTES) {
      return { error: `${names[d]}: the cafe must be open for more than 1 hour (online orders stop 1 hour before closing).` };
    }
    hours[d] = { closed: false, open: toHHMM(open), close: toHHMM(close) };
  }
  return { hours };
}

/** Whatever is stored, as a complete, safe schedule (missing/broken days fall back to the defaults). */
export function normalizeHours(raw) {
  let obj = raw;
  if (typeof obj === "string") {
    try { obj = JSON.parse(obj); } catch { obj = null; }
  }
  const out = {};
  for (let d = 0; d < 7; d++) {
    const day = obj && (obj[d] ?? obj[String(d)]);
    const open = day && toMinutes(day.open);
    const close = day && toMinutes(day.close);
    if (day && day.closed === true) out[d] = { closed: true, open: DEFAULT_HOURS[d].open, close: DEFAULT_HOURS[d].close };
    else if (open !== null && close !== null && day && close > open) out[d] = { closed: false, open: toHHMM(open), close: toHHMM(close) };
    else out[d] = { ...DEFAULT_HOURS[d] };
  }
  return out;
}

/** Reads the admin's saved hours (falls back to the defaults if nothing is saved or the read fails). */
export async function getBusinessHours(env) {
  try {
    await ensureConfigColumns(env);
    const res = await runQuery(env, "SELECT business_hours FROM app_config WHERE id = 1;");
    return normalizeHours(res.rows[0]?.business_hours);
  } catch {
    return normalizeHours(null);
  }
}

/** { open, close } in minutes past midnight for a weekday, or null when the cafe is closed all day. */
export function windowFor(hours, weekday) {
  const day = (hours || DEFAULT_HOURS)[weekday] || DEFAULT_HOURS[weekday];
  if (!day || day.closed) return null;
  return { open: toMinutes(day.open), close: toMinutes(day.close) };
}

/** Returns null when the slot is fine, otherwise a customer-facing error message. */
export function validateReservationSlot(dateStr, timeStr, hours = DEFAULT_HOURS) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || "");
  const t = /^(\d{1,2}):(\d{2})/.exec(timeStr || "");
  if (!d || !t) return "Please choose a valid date and time.";
  const weekday = new Date(Date.UTC(+d[1], +d[2] - 1, +d[3])).getUTCDay();
  const minutes = +t[1] * 60 + +t[2];
  const win = windowFor(hours, weekday);
  if (!win || minutes < win.open || minutes >= win.close) return NOT_OPEN_MESSAGE;
  if (minutes % SLOT_MINUTES !== 0) return "Please choose one of the half-hour times in the list.";

  // Not in the past (cafe time = Africa/Johannesburg)
  const now = cafeNow();
  if (dateStr < now.dateKey || (dateStr === now.dateKey && minutes <= now.minutes)) {
    return "That date and time has already passed. Please choose a future time.";
  }
  return null;
}

/** South Africa time right now: date, weekday and minutes past midnight. */
function cafeNow() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Johannesburg", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const dateKey = `${get("year")}-${get("month")}-${get("day")}`;
  return {
    dateKey,
    weekday: new Date(`${dateKey}T00:00:00Z`).getUTCDay(),
    minutes: (+get("hour") % 24) * 60 + +get("minute"),
  };
}

/** True when the cafe is open right now (South Africa time). */
export function isOpenNow(hours = DEFAULT_HOURS) {
  const now = cafeNow();
  const win = windowFor(hours, now.weekday);
  return !!win && now.minutes >= win.open && now.minutes < win.close;
}

/** True while online orders are accepted: from opening until 1 hour before closing (South Africa time). */
export function isTakingOrdersNow(hours = DEFAULT_HOURS) {
  const now = cafeNow();
  const win = windowFor(hours, now.weekday);
  return !!win && now.minutes >= win.open && now.minutes < win.close - ORDER_CUTOFF_MINUTES;
}

/**
 * Collection/delivery "Preferred Time": "As soon as possible" or a 30-minute window today ("At 18:30 - 19:00")
 * that is still ahead and before closing. Returns null when fine, otherwise a customer-facing message.
 */
export function validatePickupSlot(pickupTime, hours = DEFAULT_HOURS) {
  const m = /^at (\d{1,2}):(\d{2})(?:\s*(?:-|\u2013|to)\s*(\d{1,2}):(\d{2}))?$/i.exec(String(pickupTime || "").trim());
  if (!m) return null; // "As soon as possible" (and older wording) needs no check
  const minutes = +m[1] * 60 + +m[2];
  const endMinutes = m[3] !== undefined ? +m[3] * 60 + +m[4] : minutes + SLOT_MINUTES;
  const now = cafeNow();
  const win = windowFor(hours, now.weekday);
  if (!win || minutes % SLOT_MINUTES !== 0 || endMinutes !== minutes + SLOT_MINUTES || minutes < win.open || endMinutes > win.close) {
    return "Please choose one of the times in the Preferred Time list.";
  }
  // The list starts 2h ahead; allow a little slack for a checkout that took a while.
  if (minutes <= now.minutes + 30) {
    return "That time is too soon now. Please choose a later time from the Preferred Time list.";
  }
  return null;
}
