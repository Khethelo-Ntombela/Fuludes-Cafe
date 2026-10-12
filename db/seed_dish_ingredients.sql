-- Seed script for dish_ingredients Matches dishes to menu_items by name, reports any mismatches

DO $$
DECLARE
  dish_record RECORD;
  ingredient_list TEXT[];
  ingredient_name TEXT;
  menu_item_id INTEGER;
  matched_count INTEGER := 0;
  unmatched_dishes TEXT[] := '{}';
  total_ingredients INTEGER := 0;
BEGIN
  -- Dish to ingredients mapping
  -- Format: dish_name => array of ingredients
  FOR dish_record IN
    SELECT * FROM (VALUES
      ('Beef Ribs', ARRAY['Beef ribs', 'cooking oil', 'potatoes', 'sauce']),
      ('Pork Ribs', ARRAY['Pork ribs', 'cooking oil', 'potatoes', 'sauce']),
      ('Kota Leg', ARRAY['Chicken quarter leg', 'sauce', 'cooking oil', 'rice', 'pap', 'potatoes', 'cabbage', 'carrot', 'mayonnaise beetroot']),
      ('Mukokoroshi', ARRAY['Chicken', 'cooking oil', 'pap', 'leafy greens', 'onion', 'tomato']),
      ('Steak and Wors', ARRAY['Beef steak', 'boerewors', 'cooking oil', 'pap', 'rice', 'beetroot', 'beans', 'green pepper', 'potatoes', 'sauce']),
      ('Talapia Fish', ARRAY['Whole tilapia', 'cooking oil', 'garlic', 'lemon', 'tomato', 'onion', 'rice', 'cabbage', 'carrot', 'mayonnaise']),
      ('Stew Talapia Fish', ARRAY['Whole tilapia', 'tomato', 'onion', 'cooking oil', 'stock', 'chili', 'pap', 'rice']),
      ('Seafood Platter', ARRAY['Prawns', 'shrimp', 'mussels', 'crab sticks', 'lobster', 'scallops', 'corn', 'potatoes', 'boiled eggs', 'butter', 'lemon']),
      ('Magulu', ARRAY['Tripe', 'offal', 'tomato', 'pap', 'carrot', 'onion', 'leafy greens']),
      ('Nama ya Mbudzi', ARRAY['Goat meat', 'onion', 'tomato', 'pap', 'leafy greens']),
      ('Starter: Chicken Liver and Dumplings', ARRAY['Chicken livers', 'onion', 'tomato', 'flour', 'baking powder']),
      ('Beef Stew', ARRAY['Beef chunks', 'onion', 'tomato', 'cooking oil', 'pap', 'rice', 'creamy samp', 'beans', 'green pepper', 'carrot', 'mayonnaise', 'cabbage', 'beetroot']),
      ('Chicken Stew', ARRAY['Chicken', 'onion', 'carrot', 'beetroot', 'pap', 'leafy greens']),
      ('Chicken Wings', ARRAY['Chicken wings', 'cooking oil', 'sauce', 'potatoes']),
      ('Kiddies Meal', ARRAY['Chicken wings', 'pap', 'rice', 'carrot', 'potatoes', 'onion', 'beans', 'green pepper', 'beetroot']),
      ('Meat Platters', ARRAY['Chicken', 'beef', 'sausage', 'wors', 'potatoes', 'tomato', 'cooking oil', 'sauce']),
      ('Pizza', ARRAY['Flour', 'cooking oil', 'tomato sauce', 'mozzarella cheese', 'onion', 'peppers', 'mushroom', 'polony or ham', 'chicken']),
      ('Chakalaka', ARRAY['Beans', 'cooking oil', 'green pepper', 'carrot', 'onion']),
      ('coslow', ARRAY['Mayonnaise', 'carrot', 'cabbage']),
      ('beetroot', ARRAY['Chutney', 'beetroot', 'onion'])
    ) AS t(dish_name, ingredients)
  LOOP
    -- Try to find the menu_item by name (case-insensitive)
    SELECT id INTO menu_item_id
    FROM menu_items
    WHERE name ILIKE dish_record.dish_name
    LIMIT 1;

    IF menu_item_id IS NOT NULL THEN
      -- Clear existing ingredients for this dish (idempotent)
      DELETE FROM dish_ingredients WHERE menu_item_id = menu_item_id;

      -- Insert ingredients
      FOREACH ingredient_name IN ARRAY dish_record.ingredients
      LOOP
        INSERT INTO dish_ingredients (menu_item_id, ingredient_name)
        VALUES (menu_item_id, ingredient_name)
        ON CONFLICT (menu_item_id, ingredient_name) DO NOTHING;
        total_ingredients := total_ingredients + 1;
      END LOOP;

      matched_count := matched_count + 1;
      RAISE NOTICE 'Matched: % (id=%) - % ingredients', dish_record.dish_name, menu_item_id, array_length(dish_record.ingredients, 1);
    ELSE
      unmatched_dishes := array_append(unmatched_dishes, dish_record.dish_name);
      RAISE WARNING 'NO MATCH for dish: %', dish_record.dish_name;
    END IF;
  END LOOP;

  RAISE NOTICE '=== SUMMARY ===';
  RAISE NOTICE 'Matched dishes: %', matched_count;
  RAISE NOTICE 'Total ingredients inserted: %', total_ingredients;
  RAISE NOTICE 'Unmatched dishes: %', array_length(unmatched_dishes, 1);
  
  IF array_length(unmatched_dishes, 1) > 0 THEN
    RAISE NOTICE 'Unmatched dish names: %', array_to_string(unmatched_dishes, ', ');
  END IF;
END $$;

-- Show current menu_items for reference
SELECT id, name, category_id, price, stock_quantity, is_visible
FROM menu_items
ORDER BY name;
