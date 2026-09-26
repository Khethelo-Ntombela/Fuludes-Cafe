-- =====================================================================
-- When the "new paid order" notification went to admin/staff. It's sent
-- 1 second after the 2-minute customer-cancel window ends
-- (kitchen_release_at), once per order. Also added on the fly by
-- functions/_lib/push.js. Run in Neon SQL editor.
-- =====================================================================
ALTER TABLE orders ADD COLUMN IF NOT EXISTS new_order_push_sent_at TIMESTAMPTZ;
-- Orders paid before this existed were already notified at payment time.
UPDATE orders SET new_order_push_sent_at = NOW()
 WHERE new_order_push_sent_at IS NULL AND payment_status = 'paid';
