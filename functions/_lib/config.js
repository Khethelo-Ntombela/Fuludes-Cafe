// Makes sure the app_config table has the columns the admin "Store status" and "Business hours" settings need
import { runQuery } from "./db.js";

export async function ensureConfigColumns(env) {
  await runQuery(env, `ALTER TABLE app_config ADD COLUMN IF NOT EXISTS is_out_of_service BOOLEAN NOT NULL DEFAULT FALSE;`);
  await runQuery(env, `ALTER TABLE app_config ADD COLUMN IF NOT EXISTS out_of_service_reason TEXT;`);
  await runQuery(env, `ALTER TABLE app_config ADD COLUMN IF NOT EXISTS announcement_message TEXT;`);
  // Admin-editable opening hours (NULL = use the built-in default schedule)
  await runQuery(env, `ALTER TABLE app_config ADD COLUMN IF NOT EXISTS business_hours JSONB;`);
}
