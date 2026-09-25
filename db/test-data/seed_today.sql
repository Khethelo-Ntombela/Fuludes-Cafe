-- =====================================================================
-- TEST DATA: orders for ONE day (25/09/2026 - change target_date below)
-- so the Dashboard's "today" cards (Today's Orders, Revenue Today, Avg
-- Order Value, Delivery Orders) and the kitchen stats strip have data.
--
-- Neon > SQL Editor > paste > Run. Remove with remove_test_data.sql
-- (same markers as seed_8_months.sql: phone 000TEST..., emails
-- @fulude-test.invalid). Safe to re-run - replaces that day's test orders.
--
-- Orders are spread from 09:00 up to now (never in the future). Most are
-- completed; the last few are left New / Preparing / Ready so the Live
-- Orders board and its Waiting/Preparing/Ready stats show something -
-- these test tickets appear on the kitchen board too until removed.
-- =====================================================================
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_distance_km NUMERIC(6,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_fee NUMERIC(10,2) NOT NULL DEFAULT 0.00;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_by TEXT;

DO $$
DECLARE
  target_date DATE := DATE '2026-09-25';   -- the day to fill
  order_count INT := 28;                   -- how many orders that day
  active_left INT := 5;                    -- last N orders stay on the kitchen board
  day_start  TIMESTAMPTZ := (target_date::timestamp + TIME '09:00') AT TIME ZONE 'Africa/Johannesburg';
  day_end    TIMESTAMPTZ := LEAST(NOW() - INTERVAL '4 minutes',
                                  (target_date::timestamp + TIME '20:00') AT TIME ZONE 'Africa/Johannesburg');
  cust_ids   INT[];
  cid        INT;
  i          INT;
  at_ts      TIMESTAMPTZ;
  otype      TEXT;
  roll       NUMERIC;
  status_v   TEXT;
  pay_v      TEXT;
  fee        NUMERIC(10,2);
  dist       NUMERIC(6,2);
  items_sum  NUMERIC(10,2);
  new_order  INT;
  mi         RECORD;
  qty        INT;
  cname      TEXT;
  cphone     TEXT;
BEGIN
  IF (SELECT COUNT(*) FROM menu_items WHERE is_visible) = 0 THEN
    RAISE EXCEPTION 'No visible menu items - add some dishes to the menu first.';
  END IF;
  IF day_end <= day_start THEN
    RAISE EXCEPTION 'It is before 09:00 on % - nothing to fill yet (or pick an earlier date).', target_date;
  END IF;

  -- Test customers (created by seed_8_months.sql; made here if missing)
  FOR i IN 1..10 LOOP
    INSERT INTO customers (name, email, password_hash, password_salt, is_verified, phone_number, delivery_address)
    VALUES ('Test Customer ' || i, 'test.customer' || i || '@fulude-test.invalid', NULL, NULL, TRUE,
            '000TEST' || LPAD(i::text, 3, '0'), (10 + i) || ' Test Street, Sibasa, Thohoyandou, 0950, Limpopo')
    ON CONFLICT (email) DO NOTHING;
  END LOOP;
  SELECT array_agg(id) INTO cust_ids FROM customers WHERE email LIKE '%@fulude-test.invalid';

  -- Replace this day's earlier test orders
  DELETE FROM orders
  WHERE customer_phone LIKE '000TEST%'
    AND (created_at AT TIME ZONE 'Africa/Johannesburg')::date = target_date;

  FOR i IN 1..order_count LOOP
    -- Evenly through the day (oldest first) with a little jitter
    at_ts := day_start + (day_end - day_start) * ((i - 1 + random() * 0.8) / order_count);
    cid := cust_ids[1 + floor(random() * array_length(cust_ids, 1))::int];
    SELECT name, phone_number INTO cname, cphone FROM customers WHERE id = cid;

    roll := random();
    otype := CASE WHEN roll < 0.5 THEN 'collection' WHEN roll < 0.8 THEN 'delivery' ELSE 'dine_in' END;
    fee := 0; dist := NULL;
    IF otype = 'delivery' THEN
      dist := round((1 + random() * 12)::numeric, 2);
      fee  := CASE WHEN dist <= 3 THEN 20 WHEN dist <= 6 THEN 30 WHEN dist <= 9 THEN 40 ELSE 50 END;
    END IF;

    -- Last few are still in the kitchen; a couple of the rest are unpaid
    IF i > order_count - active_left THEN
      status_v := (ARRAY['New','Preparing','Preparing','Ready','New'])[1 + (order_count - i) % 5];
      pay_v := 'paid';
    ELSIF random() < 0.08 THEN
      status_v := 'New'; pay_v := 'awaiting';
    ELSE
      status_v := 'Completed'; pay_v := 'paid';
    END IF;

    INSERT INTO orders
      (customer_id, customer_name, customer_phone, order_type, delivery_address, delivery_distance_km, delivery_fee,
       table_number, pickup_time, total_amount, status, payment_method, payment_status, payment_ref,
       payment_confirmed_at, kitchen_release_at, stock_decremented, created_at)
    VALUES
      (cid, cname, cphone, otype,
       CASE WHEN otype = 'delivery' THEN (SELECT delivery_address FROM customers WHERE id = cid) END,
       dist, fee,
       CASE WHEN otype = 'dine_in' THEN (1 + floor(random() * 12))::text END,
       'As soon as possible', 0, status_v, 'online', pay_v,
       CASE WHEN pay_v = 'paid' THEN 'ch_test_seed_' || md5(random()::text) END,
       CASE WHEN pay_v = 'paid' THEN at_ts + INTERVAL '1 minute' END,
       CASE WHEN pay_v = 'paid' THEN at_ts + INTERVAL '3 minutes' END,
       pay_v = 'paid', at_ts)
    RETURNING id INTO new_order;

    items_sum := 0;
    FOR mi IN SELECT id, name, COALESCE(special_price, price) AS price FROM menu_items WHERE is_visible
              ORDER BY random() LIMIT 1 + floor(random() * 3)::int LOOP
      qty := 1 + floor(power(random(), 3) * 3)::int;
      INSERT INTO order_items (order_id, menu_item_id, item_name, item_price, quantity, spice_level, extras, subtotal)
      VALUES (new_order, mi.id, mi.name, mi.price, qty, NULL, '[]', mi.price * qty);
      items_sum := items_sum + mi.price * qty;
    END LOOP;
    UPDATE orders SET total_amount = items_sum + fee WHERE id = new_order;
  END LOOP;
END $$;

-- What the "today" cards should show (paid orders on that day)
SELECT COUNT(*) FILTER (WHERE payment_status = 'paid')                            AS todays_paid_orders,
       SUM(total_amount) FILTER (WHERE payment_status = 'paid')                   AS revenue_today,
       ROUND(AVG(total_amount) FILTER (WHERE payment_status = 'paid'), 2)         AS avg_order_value,
       COUNT(*) FILTER (WHERE payment_status = 'paid' AND order_type = 'delivery') AS delivery_orders,
       COUNT(*) FILTER (WHERE status IN ('New','Preparing','Ready') AND payment_status = 'paid') AS on_kitchen_board,
       COUNT(*) FILTER (WHERE payment_status = 'awaiting')                        AS unpaid
FROM orders
WHERE customer_phone LIKE '000TEST%'
  AND (created_at AT TIME ZONE 'Africa/Johannesburg')::date = DATE '2026-09-25';
