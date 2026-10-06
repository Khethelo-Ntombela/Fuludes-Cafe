-- =====================================================================
-- Delivery ETA on the customer's order tracker.
-- out_for_delivery_at is stamped when staff/admin move an order to Delivery.
-- delivered_at is set when the cafe ticks "Delivered" in admin Order History
-- (separate from Completed, which only clears the live kitchen screens).
-- Also added on the fly by functions/_lib/scheduledOrders.js. Run in Neon SQL editor.
-- =====================================================================
ALTER TABLE orders ADD COLUMN IF NOT EXISTS out_for_delivery_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
