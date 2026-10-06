import { runQuery } from "./db.js";

let ready = false;
export async function ensureScheduleColumns(env) {
  if (ready) return;
  await runQuery(env, "ALTER TABLE orders ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMPTZ;");
  await runQuery(env, "ALTER TABLE orders ADD COLUMN IF NOT EXISTS preparing_at TIMESTAMPTZ;");
  // Delivery ETA: when the order left the kitchen, and when the cafe ticked it as delivered.
  await runQuery(env, "ALTER TABLE orders ADD COLUMN IF NOT EXISTS out_for_delivery_at TIMESTAMPTZ;");
  await runQuery(env, "ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;");
  ready = true;
}

const RELATIVE = { "in 30 minutes": 30, "in 1 hour": 60, "in 2 hours": 120 };
const SA_OFFSET_MIN = 120;

export function scheduledForFromPickup(pickupTime, now = new Date()) {
  const text = String(pickupTime || "").trim().toLowerCase();
  if (RELATIVE[text]) return new Date(now.getTime() + RELATIVE[text] * 60000);
  const m = /^arriving at (\d{1,2}):(\d{2})\s*(am|pm)$/.exec(text);
  if (!m) return null;
  let h = +m[1] % 12;
  if (m[3] === "pm") h += 12;
  const sa = new Date(now.getTime() + SA_OFFSET_MIN * 60000);
  const due = Date.UTC(sa.getUTCFullYear(), sa.getUTCMonth(), sa.getUTCDate(), h, +m[2]) - SA_OFFSET_MIN * 60000;
  return due > now.getTime() ? new Date(due) : null;
}

export async function scheduledForFromReservation(env, reservationId, customerId) {
  const r = await runQuery(
    env,
    `SELECT ((reservation_date + reservation_time) AT TIME ZONE 'Africa/Johannesburg') AS due
       FROM customer_reservations WHERE id = $1 AND customer_id = $2;`,
    [reservationId, customerId],
  ).catch(() => null);
  const due = r?.rows?.[0]?.due;
  return due ? new Date(due) : null;
}
