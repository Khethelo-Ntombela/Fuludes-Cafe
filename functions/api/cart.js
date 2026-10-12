/**
 * functions/api/cart.js
 * -----------------------------------------------------------------------
 * The signed-in customer's saved cart - the same cart on every device
 * (see functions/_lib/savedCart.js for what is stored and how it is
 * rebuilt from the live menu). Every route needs a customer session.
 *
 * GET    /api/cart
 *   -> { items, version, notices }
 *      items are full cart lines priced from today's menu; notices say
 *      what was removed or changed (sold out, side options changed, ...).
 *
 * PUT    /api/cart   { items: [{ itemId, quantity, spiceLevel, sideId, extraIds }] }
 *   Replaces the saved cart with what this device shows. Same response.
 *
 * POST   /api/cart   { items: [...] }
 *   Merges what this device holds into the saved cart (identical lines
 *   have their quantities added) - used the first time a device meets the
 *   account, e.g. right after signing in with items already in the cart.
 *   Same response.
 *
 * DELETE /api/cart
 *   Empties the saved cart.
 * -----------------------------------------------------------------------
 */
import { jsonResponse } from "../_lib/db.js";
import { requireCustomer } from "../_lib/customerAuth.js";
import {
  compactFromLines,
  hydrateCart,
  loadSavedCart,
  mergeCompact,
  normalizeCompact,
  tidySavedCart,
  writeSavedCart,
  clearSavedCart,
} from "../_lib/savedCart.js";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

async function readItems(request) {
  try {
    const body = await request.json();
    return Array.isArray(body?.items) ? body.items : null;
  } catch {
    return null;
  }
}

/** Rebuilds the cart from the live menu, saves the tidied version, and shapes the reply. */
async function respondWithCart(env, customerId, compact, { write, readVersion }) {
  const { lines, notices } = await hydrateCart(env, compact);
  const cleaned = compactFromLines(lines);
  const changed = JSON.stringify(cleaned) !== JSON.stringify(normalizeCompact(compact));

  let version;
  if (write) version = await writeSavedCart(env, customerId, cleaned);
  else if (changed) version = await tidySavedCart(env, customerId, cleaned, readVersion);
  else version = readVersion;

  return jsonResponse({ success: true, items: lines, version, notices }, 200, NO_STORE);
}

export async function onRequestGet({ request, env }) {
  const { customer, error } = await requireCustomer(request, env);
  if (error) return error;
  try {
    const saved = await loadSavedCart(env, customer.id);
    return await respondWithCart(env, customer.id, saved.items, { write: false, readVersion: saved.version });
  } catch (err) {
    return jsonResponse({ error: "Couldn't load your saved cart.", message: err.message }, 500);
  }
}

export async function onRequestPut({ request, env }) {
  const { customer, error } = await requireCustomer(request, env);
  if (error) return error;
  const items = await readItems(request);
  if (!items) return jsonResponse({ error: "Send the cart as { items: [...] }." }, 400);
  try {
    return await respondWithCart(env, customer.id, items, { write: true });
  } catch (err) {
    return jsonResponse({ error: "Couldn't save your cart.", message: err.message }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  const { customer, error } = await requireCustomer(request, env);
  if (error) return error;
  const items = await readItems(request);
  if (!items) return jsonResponse({ error: "Send the cart as { items: [...] }." }, 400);
  try {
    const saved = await loadSavedCart(env, customer.id);
    const merged = mergeCompact(saved.items, items);
    return await respondWithCart(env, customer.id, merged, { write: true });
  } catch (err) {
    return jsonResponse({ error: "Couldn't merge your cart.", message: err.message }, 500);
  }
}

export async function onRequestDelete({ request, env }) {
  const { customer, error } = await requireCustomer(request, env);
  if (error) return error;
  await clearSavedCart(env, customer.id);
  return jsonResponse({ success: true, items: [], version: 0, notices: [] }, 200, NO_STORE);
}
