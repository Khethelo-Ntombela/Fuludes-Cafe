-- =====================================================================
-- Remove delivery_tracking_url column (feature removed)
-- Run in Neon SQL editor
-- =====================================================================

ALTER TABLE orders DROP COLUMN IF EXISTS delivery_tracking_url;