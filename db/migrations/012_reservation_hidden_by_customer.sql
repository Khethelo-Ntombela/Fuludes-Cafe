-- =====================================================================
-- Customer "Clear history" on the website's reservation window hides
-- their bookings from their own list only; the cafe keeps them. Also
-- added on the fly by functions/api/reservations.js. Run in Neon SQL editor.
-- =====================================================================
ALTER TABLE customer_reservations ADD COLUMN IF NOT EXISTS hidden_by_customer BOOLEAN NOT NULL DEFAULT FALSE;
