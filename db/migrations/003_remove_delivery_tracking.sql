-- Remove delivery_tracking_url column (feature removed)

ALTER TABLE orders DROP COLUMN IF EXISTS delivery_tracking_url;
