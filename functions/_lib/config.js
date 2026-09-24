/**
 * functions/_lib/config.js
 * -----------------------------------------------------------------------
 * Makes sure the app_config table has the columns the admin "Store status"
 * settings need, so the site keeps working even if the SQL migration
 * (db/migrations/007_store_status.sql) hasn't been run yet.
 * -----------------------------------------------------------------------
 */
import { runQuery } from "./db.js";

export async function ensureConfigColumns(env) {
  await runQuery(env, `ALTER TABLE app_config ADD COLUMN IF NOT EXISTS is_out_of_service BOOLEAN NOT NULL DEFAULT FALSE;`);
  await runQuery(env, `ALTER TABLE app_config ADD COLUMN IF NOT EXISTS out_of_service_reason TEXT;`);
  await runQuery(env, `ALTER TABLE app_config ADD COLUMN IF NOT EXISTS announcement_message TEXT;`);
}
