-- =====================================================================
-- dish_ingredients: static "what's inside what" lookup
-- No stock quantities, no per-ingredient inventory.
-- Just which ingredients belong to which menu item.
-- =====================================================================

CREATE TABLE IF NOT EXISTS dish_ingredients (
  id               SERIAL PRIMARY KEY,
  menu_item_id     INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  ingredient_name  TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (menu_item_id, ingredient_name)
);

CREATE INDEX IF NOT EXISTS idx_dish_ingredients_item ON dish_ingredients(menu_item_id);
CREATE INDEX IF NOT EXISTS idx_dish_ingredients_name ON dish_ingredients(ingredient_name);

-- =====================================================================
-- Seed data: match by dish name to menu_items.id
-- Run this AFTER menu items exist.
-- Dishes that don't match existing menu_items will be reported.
-- =====================================================================

-- This is a template - actual seed should be run via a script that matches
-- dish names to menu_items.id and reports mismatches.
-- See db/seed_dish_ingredients.sql for the executable version.