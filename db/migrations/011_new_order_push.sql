-- When the "new paid order" notification went to admin/staff

ALTER TABLE orders ADD COLUMN IF NOT EXISTS new_order_push_sent_at TIMESTAMPTZ;
-- Orders paid before this existed were already notified at payment time.
UPDATE orders SET new_order_push_sent_at = NOW()
 WHERE new_order_push_sent_at IS NULL AND payment_status = 'paid';
