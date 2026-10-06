-- =====================================================================
-- Who cancelled an order: 'customer' (inside the 2-minute window, refunded
-- automatically through Yoco), 'staff' or 'admin' (refund done from the
-- admin Order History). Also added on the fly by functions/_lib/orderCancel.js.
-- Run in Neon SQL editor.
-- =====================================================================
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_by TEXT;
