-- Drinks sub-types

ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS drink_type TEXT; -- beverage | cocktail | alcohol | other
