-- Delivery fee bands, cafe location, delivery fields on orders

CREATE TABLE IF NOT EXISTS delivery_fee_bands (
  id          SERIAL PRIMARY KEY,
  up_to_km    INTEGER NOT NULL UNIQUE,   -- 3, 6, 9, ..., 51
  fee         NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  sort_order  INTEGER NOT NULL DEFAULT 0, -- 1..17 ascending by up_to_km
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed the 17 fixed 3km bands (fee = 0.00 initially, admin sets real prices)
INSERT INTO delivery_fee_bands (up_to_km, fee, sort_order) VALUES
  (3,  0.00, 1), (6,  0.00, 2), (9,  0.00, 3), (12, 0.00, 4),
  (15, 0.00, 5), (18, 0.00, 6), (21, 0.00, 7), (24, 0.00, 8),
  (27, 0.00, 9), (30, 0.00, 10), (33, 0.00, 11), (36, 0.00, 12),
  (39, 0.00, 13), (42, 0.00, 14), (45, 0.00, 15), (48, 0.00, 16),
  (51, 0.00, 17)
ON CONFLICT (up_to_km) DO NOTHING;

-- ---------------------------------------------------------------------
-- Extend app_config with cafe coordinates and contact info
-- ---------------------------------------------------------------------
ALTER TABLE app_config ADD COLUMN IF NOT EXISTS cafe_latitude  NUMERIC(9,6);
ALTER TABLE app_config ADD COLUMN IF NOT EXISTS cafe_longitude NUMERIC(9,6);
ALTER TABLE app_config ADD COLUMN IF NOT EXISTS cafe_phone     TEXT;
ALTER TABLE app_config ADD COLUMN IF NOT EXISTS cafe_email     TEXT;

-- Set default cafe location (Thohoyandou, Limpopo) and contact
UPDATE app_config
SET cafe_latitude  = -22.98341,
    cafe_longitude = 30.35963,
    cafe_phone     = '+27 663 649 016',
    cafe_email     = 'info@fuludescafe.co.za'
WHERE id = 1
  AND (cafe_latitude IS NULL OR cafe_longitude IS NULL);

-- ---------------------------------------------------------------------
-- Extend orders table with delivery tracking fields
-- ---------------------------------------------------------------------
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_lat           NUMERIC(9,6);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_lng           NUMERIC(9,6);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_distance_km   NUMERIC(6,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_fee           NUMERIC(10,2) NOT NULL DEFAULT 0.00;
