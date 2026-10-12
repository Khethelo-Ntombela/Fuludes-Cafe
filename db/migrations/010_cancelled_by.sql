-- Who cancelled an order: customer, staff or admin

ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_by TEXT;
