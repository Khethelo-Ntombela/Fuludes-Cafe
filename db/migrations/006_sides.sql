-- =====================================================================
-- Free "choice of side" (e.g. Chips / Pap / Rice).
-- Managed on the admin Extras tab, then ticked (optionally) per dish.
-- Run once in the Neon SQL editor after deploying.
-- =====================================================================
CREATE TABLE IF NOT EXISTS sides (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS menu_item_sides (
  menu_item_id  INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  side_id       INTEGER NOT NULL REFERENCES sides(id) ON DELETE CASCADE,
  PRIMARY KEY (menu_item_id, side_id)
);
