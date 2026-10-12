-- Customers can hide their own reservation history; the cafe keeps the rows

ALTER TABLE customer_reservations ADD COLUMN IF NOT EXISTS hidden_by_customer BOOLEAN NOT NULL DEFAULT FALSE;
