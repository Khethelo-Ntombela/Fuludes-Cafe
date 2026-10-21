// Cafe opening hours (South Africa time) + reservation slot validation
const OPEN_MIN = 9 * 60;
export const NOT_OPEN_MESSAGE =
  "Sorry, try a different time because we don't operate at the time you chose.";

export const SLOT_MINUTES = 30; // reservations and chosen collection/delivery times are on the half-hour

export function closeMinutesFor(weekday) {
  // weekday: 0 = Sunday ... 6 = Saturday
  return weekday === 6 ? 21 * 60 : weekday === 5 || weekday === 0 ? 20 * 60 : 18 * 60;
}

/** Returns null when the slot is fine, otherwise a customer-facing error message. */
export function validateReservationSlot(dateStr, timeStr) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || "");
  const t = /^(\d{1,2}):(\d{2})/.exec(timeStr || "");
  if (!d || !t) return "Please choose a valid date and time.";
  const weekday = new Date(Date.UTC(+d[1], +d[2] - 1, +d[3])).getUTCDay();
  const minutes = +t[1] * 60 + +t[2];
  if (minutes < OPEN_MIN || minutes >= closeMinutesFor(weekday)) return NOT_OPEN_MESSAGE;
  if (minutes % SLOT_MINUTES !== 0) return "Please choose one of the half-hour times in the list.";

  // Not in the past (cafe time = Africa/Johannesburg)
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Johannesburg", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const today = `${get("year")}-${get("month")}-${get("day")}`;
  const nowMin = (+get("hour") % 24) * 60 + +get("minute");
  if (dateStr < today || (dateStr === today && minutes <= nowMin)) {
    return "That date and time has already passed. Please choose a future time.";
  }
  return null;
}

export const CLOSED_MESSAGE = "Can't order at this time, we are currently closed.";

/** True when the cafe is open right now (South Africa time). */
export function isOpenNow() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Africa/Johannesburg", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  const minutes = (+get("hour") % 24) * 60 + +get("minute");
  return minutes >= OPEN_MIN && minutes < closeMinutesFor(weekday);
}

export const ORDER_CUTOFF_MINUTES = 60; // online orders stop this long before closing
export const LAST_ORDERS_MESSAGE =
  "Sorry, we've stopped taking online orders for today. Orders close 1 hour before closing time.";

/** True while online orders are accepted: from opening until 1 hour before closing (South Africa time). */
export function isTakingOrdersNow() {
  const now = cafeNow();
  return now.minutes >= OPEN_MIN && now.minutes < closeMinutesFor(now.weekday) - ORDER_CUTOFF_MINUTES;
}

/** South Africa time right now: weekday and minutes past midnight. */
function cafeNow() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Africa/Johannesburg", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return {
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday")),
    minutes: (+get("hour") % 24) * 60 + +get("minute"),
  };
}

/**
 * Collection/delivery "Preferred Time": "As soon as possible" or a half-hour slot today ("At 18:30")
 * that is still ahead and before closing. Returns null when fine, otherwise a customer-facing message.
 */
export function validatePickupSlot(pickupTime) {
  const m = /^at (\d{1,2}):(\d{2})$/i.exec(String(pickupTime || "").trim());
  if (!m) return null; // "As soon as possible" (and older wording) needs no check
  const minutes = +m[1] * 60 + +m[2];
  const now = cafeNow();
  if (minutes % SLOT_MINUTES !== 0 || minutes < OPEN_MIN || minutes >= closeMinutesFor(now.weekday)) {
    return "Please choose one of the times in the Preferred Time list.";
  }
  // The list starts 1h30 ahead; allow a little slack for a checkout that took a while.
  if (minutes <= now.minutes + 30) {
    return "That time is too soon now. Please choose a later time from the Preferred Time list.";
  }
  return null;
}
