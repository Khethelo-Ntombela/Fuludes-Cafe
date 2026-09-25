/**
 * functions/_lib/orderCancel.js
 * orders.cancelled_by ('customer' | 'staff' | 'admin') - who cancelled an
 * order, shown in admin Order History (migration 010, also added here on
 * the fly so older databases keep working).
 */
import { runQuery } from "./db.js";

let ready = false;
export async function ensureCancelledByColumn(env) {
  if (ready) return;
  await runQuery(env, "ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_by TEXT;");
  // refund_ref / refund_error come from migration 004 - make sure they exist too.
  await runQuery(env, "ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_ref TEXT;");
  await runQuery(env, "ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_error TEXT;");
  ready = true;
}
