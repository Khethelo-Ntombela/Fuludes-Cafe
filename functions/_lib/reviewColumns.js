// Makes sure the review table has the column that holds the admin's reason for rejecting a review.
// (Older databases do not have it yet.)
import { runQuery } from "./db.js";

let reviewColumnsReady = false;

export async function ensureReviewColumns(env) {
  if (reviewColumnsReady) return;
  await runQuery(env, "ALTER TABLE reviews ADD COLUMN IF NOT EXISTS rejection_reason TEXT;");
  reviewColumnsReady = true;
}
