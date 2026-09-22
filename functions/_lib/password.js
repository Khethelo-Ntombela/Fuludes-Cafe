/**
 * functions/_lib/password.js
 * -----------------------------------------------------------------------
 * Password hashing for customer accounts, using PBKDF2-SHA256 via the Web
 * Crypto API (`crypto.subtle`), which is natively available in Cloudflare
 * Workers. We deliberately don't use bcrypt/argon2 here - those need
 * native/binary bindings that Workers can't run, the same reason
 * functions/_lib/md5.js is hand-rolled pure JS for legacy gateway
 * compatibility.
 *
 * Each password gets its own random 16-byte salt (stored alongside the
 * hash on the `customers` row), and 100,000 PBKDF2 iterations, which is a
 * reasonable, widely-recommended cost factor for this algorithm.
 * -----------------------------------------------------------------------
 */

const ITERATIONS = 100000;
const KEY_LENGTH_BITS = 256;

function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

async function deriveHex(password, saltBytes) {
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const derivedBits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBytes, iterations: ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    KEY_LENGTH_BITS
  );
  return bytesToHex(derivedBits);
}

/** Hashes a plaintext password, returning a fresh random salt + the resulting hash, both hex strings. */
export async function hashPassword(password) {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const salt = bytesToHex(saltBytes);
  const hash = await deriveHex(password, saltBytes);
  return { hash, salt };
}

/** Re-derives the hash for a candidate password against a stored salt, and compares it to the stored hash. */
export async function verifyPassword(password, storedHash, storedSalt) {
  const candidateHash = await deriveHex(password, hexToBytes(storedSalt));
  return candidateHash === storedHash;
}

/** A long random session/reset token - plain hex, no external uuid dependency needed. */
export function generateToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return bytesToHex(bytes);
}
