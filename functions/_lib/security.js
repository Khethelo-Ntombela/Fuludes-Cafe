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

export function getRequestIp(request) {
  const cfIp = request.headers.get("CF-Connecting-IP");
  const forwarded = request.headers.get("X-Forwarded-For");
  const rawIp = cfIp || forwarded || "";
  return rawIp.split(",")[0].trim() || "unknown";
}
