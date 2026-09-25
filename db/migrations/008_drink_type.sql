-- =====================================================================
-- Drinks sub-types. Items in a drinks category (slug/name containing
-- "drink" or "beverage") are listed on the customer menu under the
-- Drinks tab only, grouped Beverages -> Cocktails -> Alcohol -> Other.
-- NULL for food. functions/api/admin/menu.js also adds this on the fly.
-- Run in Neon SQL editor.
-- =====================================================================
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS drink_type TEXT; -- beverage | cocktail | alcohol | other
