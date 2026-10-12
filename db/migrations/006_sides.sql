-- Free choice of side (chips / pap / rice), ticked per dish

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
