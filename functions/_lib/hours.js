// Cafe opening hours (South Africa time) + reservation slot validation
const OPEN_MIN = 9 * 60;
export const NOT_OPEN_MESSAGE =
  "Sorry, try a different time because we don't operate at the time you chose.";

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
