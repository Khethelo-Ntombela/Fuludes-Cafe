/**
 * functions/_lib/security.js
 * -----------------------------------------------------------------------
 * Shared security helpers for request sanitation, client IP extraction,
 * and other low-level protection mechanisms.
 * -----------------------------------------------------------------------
 */

export function sanitizeText(value, maxLength = 2000) {
  if (value == null) return "";
  let text = String(value).trim();
  text = text.replace(/[\u0000-\u001F\u007F]/g, "");
  text = text.replace(/[<>]/g, "");
  if (text.length > maxLength) {
    text = text.slice(0, maxLength);
  }
  return text;
}

/* ---------------- Form field validation ----------------
 * The same rules run in the browser (public/js/site.js, "Form validation")
 * so customers see problems before sending; these are the ones that count. */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isValidEmail(email) {
  const e = String(email || "").trim();
  return e.length <= 254 && EMAIL_RE.test(e);
}

/** 2-100 characters with at least one letter ("J" or "12345" is not a name). */
export function isValidName(name) {
  const n = String(name || "").trim();
  return n.length >= 2 && n.length <= 100 && /\p{L}/u.test(n);
}

/**
 * Returns the phone number cleaned to digits (keeping a leading +), or null
 * if it isn't a real number. Spaces, dashes, dots and brackets are allowed.
 * South African numbers: 0 + 9 digits, or +27 / 27 + 9 digits; other
 * international numbers: 9-15 digits.
 */
export function normalizePhone(phone) {
  const raw = String(phone || "").trim();
  if (!raw || !/^\+?[\d\s().-]+$/.test(raw)) return null;
  const plus = raw.startsWith("+");
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith("0")) return digits.length === 10 ? digits : null;
  if (digits.startsWith("27")) return digits.length === 11 ? `+${digits}` : null;
  if (digits.length < 9 || digits.length > 15) return null;
  return plus ? `+${digits}` : digits;
}

export const VALIDATION_MESSAGES = {
  name: "Please enter your full name (at least 2 letters).",
  email: "Please enter a valid email address, e.g. name@example.com.",
  phone: "Please enter a valid phone number, e.g. 066 364 9016 or +27 66 364 9016.",
};

export function getRequestIp(request) {
  const cfIp = request.headers.get("CF-Connecting-IP");
  const forwarded = request.headers.get("X-Forwarded-For");
  const rawIp = cfIp || forwarded || "";
  return rawIp.split(",")[0].trim() || "unknown";
}
