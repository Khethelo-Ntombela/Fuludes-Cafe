-- =====================================================================
-- Scheduled orders: scheduled_for is the time a pre-order / timed order is
-- actually due (table pre-orders, "In 1 hour", "Arriving at 7:30 PM").
-- preparing_at is stamped when the kitchen presses Start Preparing.
-- The kitchen dashboard (Avg Ticket Age / Longest Waiting) uses both so
-- orders that are not due yet are not counted as waiting.
-- Also added on the fly by functions/_lib/scheduledOrders.js. Run in Neon SQL editor.
-- =====================================================================
ALTER TABLE orders ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS preparing_at TIMESTAMPTZ;
