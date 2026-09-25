-- =====================================================================
-- TEST DATA: ~8 months of realistic orders for testing the admin
-- Dashboard and Sales & Reports (revenue, monthly charts, categories,
-- busiest hours, order types, top customers, refunds, unpaid orders,
-- reviews).
--
-- HOW TO RUN: Neon console > SQL Editor > paste this whole file > Run.
--   Strongly recommended: run it on a Neon *branch* (Branches > Create
--   branch, then point a preview deployment at it) instead of the live
--   database - test orders take up order numbers and count in the stats
--   until they're removed.
-- HOW TO REMOVE: run db/test-data/remove_test_data.sql.
--
-- Everything created here is marked so it can be found and removed:
--   test customers: email ends with @fulude-test.invalid (they can't log in)
--   test orders:    customer_phone starts with 000TEST
-- Uses your real menu (visible menu_items) - add a few dishes first.
-- Nothing is created for today, so the live kitchen board stays clean.
-- Safe to re-run: it removes any earlier test data first.
-- =====================================================================

-- Columns the app adds over time (no-ops if they already exist)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_lat NUMERIC(9,6);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_lng NUMERIC(9,6);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_distance_km NUMERIC(6,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_fee NUMERIC(10,2) NOT NULL DEFAULT 0.00;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_ref TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_error TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_by TEXT;

DO $$
DECLARE
  first_names TEXT[] := ARRAY['Thabo','Lerato','Sipho','Naledi','Khanya','Mpho','Rudzani','Tshilidzi','Ndivhuwo','Azwinndini',
                              'Lufuno','Mashudu','Zanele','Bongani','Precious','Kagiso','Refilwe','Nomsa','Tebogo','Fulufhelo',
                              'Vhahangwele','Pfarelo','Mulalo','Ronewa','Tendani'];
  last_names  TEXT[] := ARRAY['Ndou','Mudau','Netshitenzhe','Ramabulana','Khoza','Mokoena','Dlamini','Nkosi','Maluleke','Baloyi'];
  suburbs     TEXT[] := ARRAY['Sibasa','Shayandima','Makwarela','Tshilidzini','Maniini','Thohoyandou Block G','Itsani','Muledane'];
  pickup_opts TEXT[] := ARRAY['As soon as possible','As soon as possible','As soon as possible','In 30 minutes','In 1 hour'];
  review_txt  TEXT[] := ARRAY['Delicious and hot, will order again!','Great portions for the price.','Food was good but took a bit long.',
                              'Best chicken in town.','Friendly service and tasty meal.','Loved the chakalaka!','Good, but a little too spicy for me.',
                              'Quick delivery, still warm.','Always consistent, my go-to spot.','Nice atmosphere for dine-in.'];

  cust_ids   INT[] := '{}';
  cid        INT;
  i          INT;
  d          DATE;
  day_count  INT;
  n          INT;
  k          INT;
  line_count INT;
  start_date DATE := (CURRENT_DATE - INTERVAL '8 months')::date;
  months_in  NUMERIC;
  opens_min  INT := 9 * 60;
  closes_min INT;
  at_ts      TIMESTAMPTZ;
  otype      TEXT;
  roll       NUMERIC;
  status_v   TEXT;
  pay_v      TEXT;
  cancelled  TEXT;
  refund_nd  BOOLEAN;
  refunded_at TIMESTAMPTZ;
  fee        NUMERIC(10,2);
  dist       NUMERIC(6,2);
  items_sum  NUMERIC(10,2);
  new_order  INT;
  mi         RECORD;
  qty        INT;
  cname      TEXT;
  cphone     TEXT;
  review_cnt INT := 0;
BEGIN
  IF (SELECT COUNT(*) FROM menu_items WHERE is_visible) = 0 THEN
    RAISE EXCEPTION 'No visible menu items - add some dishes to the menu first.';
  END IF;

  -- Start clean: remove earlier test data (same as remove_test_data.sql)
  DELETE FROM reviews WHERE customer_id IN (SELECT id FROM customers WHERE email LIKE '%@fulude-test.invalid');
  DELETE FROM orders WHERE customer_phone LIKE '000TEST%';
  DELETE FROM customers WHERE email LIKE '%@fulude-test.invalid';

  -- 25 test customers (no password - they can't sign in)
  FOR i IN 1..25 LOOP
    INSERT INTO customers (name, email, password_hash, password_salt, is_verified, phone_number, delivery_address, created_at)
    VALUES (
      first_names[i] || ' ' || last_names[1 + (i % array_length(last_names, 1))],
      'test.customer' || i || '@fulude-test.invalid',
      NULL, NULL, TRUE,
      '000TEST' || LPAD(i::text, 3, '0'),
      (10 + i) || ' Test Street, ' || suburbs[1 + (i % array_length(suburbs, 1))] || ', Thohoyandou, 0950, Limpopo',
      start_date - INTERVAL '1 month'
    )
    RETURNING id INTO cid;
    cust_ids := cust_ids || cid;
  END LOOP;

  -- One day at a time, up to yesterday
  d := start_date;
  WHILE d < CURRENT_DATE LOOP
    -- Business grows over the 8 months; Fri/Sat busier, Sunday quieter
    months_in := (d - start_date) / 30.0;
    day_count := 5 + floor(random() * 7)::int + floor(months_in * 1.2)::int;
    IF EXTRACT(DOW FROM d) IN (5, 6) THEN day_count := round(day_count * 1.6); END IF;
    IF EXTRACT(DOW FROM d) = 0 THEN day_count := round(day_count * 0.7); END IF;
    -- closing time matches functions/_lib/hours.js (Sun/Fri 20:00, Sat 21:00, else 18:00)
    closes_min := CASE EXTRACT(DOW FROM d)::int WHEN 0 THEN 20*60 WHEN 5 THEN 20*60 WHEN 6 THEN 21*60 ELSE 18*60 END;

    FOR n IN 1..day_count LOOP
      -- Lunch (12-14h) and dinner (17-19h) peaks
      roll := random();
      at_ts := ((d::timestamp
                + make_interval(mins => LEAST(closes_min - 5, GREATEST(opens_min,
                    CASE WHEN roll < 0.40 THEN 12*60 + floor(random()*120)::int
                         WHEN roll < 0.70 THEN 17*60 + floor(random()*150)::int
                         ELSE opens_min + floor(random() * (closes_min - opens_min))::int END))))
               AT TIME ZONE 'Africa/Johannesburg');

      -- A few regulars order much more often (top customers)
      cid := cust_ids[1 + floor(power(random(), 1.4) * array_length(cust_ids, 1))::int];
      SELECT name, phone_number INTO cname, cphone FROM customers WHERE id = cid;

      roll := random();
      otype := CASE WHEN roll < 0.55 THEN 'collection' WHEN roll < 0.85 THEN 'delivery' ELSE 'dine_in' END;
      fee := 0; dist := NULL;
      IF otype = 'delivery' THEN
        dist := round((1 + random() * 14)::numeric, 2);
        fee  := CASE WHEN dist <= 3 THEN 20 WHEN dist <= 6 THEN 30 WHEN dist <= 9 THEN 40 WHEN dist <= 12 THEN 50 ELSE 60 END;
      END IF;

      -- Outcome: mostly completed; some cancellations/refunds and unpaid ones
      roll := random();
      cancelled := NULL; refund_nd := FALSE; refunded_at := NULL;
      IF roll < 0.86 THEN status_v := 'Completed'; pay_v := 'paid';
      ELSIF roll < 0.89 THEN status_v := 'Cancelled'; pay_v := 'refunded'; cancelled := 'customer'; refunded_at := at_ts + INTERVAL '2 minutes';
      ELSIF roll < 0.91 THEN status_v := 'Cancelled'; pay_v := 'refunded'; cancelled := (ARRAY['staff','admin'])[1 + floor(random()*2)::int]; refunded_at := at_ts + INTERVAL '1 day';
      ELSIF roll < 0.93 THEN status_v := 'Cancelled'; pay_v := 'paid'; cancelled := (ARRAY['staff','admin'])[1 + floor(random()*2)::int]; refund_nd := TRUE;
      ELSIF roll < 0.97 THEN status_v := 'New'; pay_v := 'awaiting';      -- abandoned at checkout
      ELSE status_v := 'New'; pay_v := 'failed';                          -- card declined
      END IF;

      INSERT INTO orders
        (customer_id, customer_name, customer_phone, order_type, delivery_address, delivery_lat, delivery_lng,
         delivery_distance_km, delivery_fee, table_number, pickup_time, special_instructions, total_amount,
         status, payment_method, payment_status, payment_ref, payment_confirmed_at, kitchen_release_at,
         stock_decremented, refund_needed, refund_processed_at, refund_ref, cancelled_by, created_at)
      VALUES
        (cid, cname, cphone, otype,
         CASE WHEN otype = 'delivery' THEN (SELECT delivery_address FROM customers WHERE id = cid) END,
         CASE WHEN otype = 'delivery' THEN -22.95 + (random() - 0.5) * 0.1 END,
         CASE WHEN otype = 'delivery' THEN 30.48 + (random() - 0.5) * 0.1 END,
         dist, fee,
         CASE WHEN otype = 'dine_in' THEN (1 + floor(random() * 12))::text END,
         CASE WHEN otype = 'dine_in' THEN 'As soon as possible' ELSE pickup_opts[1 + floor(random() * 5)::int] END,
         CASE WHEN random() < 0.1 THEN 'Extra sauce please' END,
         0,  -- filled in after the items
         status_v, 'online', pay_v,
         CASE WHEN pay_v IN ('paid','refunded') THEN 'ch_test_seed_' || md5(random()::text) END,
         CASE WHEN pay_v IN ('paid','refunded') THEN at_ts + INTERVAL '1 minute' END,
         CASE WHEN pay_v IN ('paid','refunded') THEN at_ts + INTERVAL '3 minutes' END,
         pay_v IN ('paid','refunded'), refund_nd, refunded_at,
         CASE WHEN refunded_at IS NOT NULL THEN 'rfnd_test_seed_' || md5(random()::text) END,
         cancelled, at_ts)
      RETURNING id INTO new_order;

      -- 1-4 dishes from the real menu
      line_count := 1 + floor(power(random(), 1.5) * 4)::int;
      items_sum := 0;
      FOR mi IN SELECT id, name, COALESCE(special_price, price) AS price FROM menu_items WHERE is_visible ORDER BY random() LIMIT line_count LOOP
        qty := 1 + floor(power(random(), 3) * 3)::int;
        INSERT INTO order_items (order_id, menu_item_id, item_name, item_price, quantity, spice_level, extras, subtotal)
        VALUES (new_order, mi.id, mi.name, mi.price, qty, NULL, '[]', mi.price * qty);
        items_sum := items_sum + mi.price * qty;
      END LOOP;
      UPDATE orders SET total_amount = items_sum + fee WHERE id = new_order;

      -- About 1 in 20 paid, completed orders gets a review
      IF status_v = 'Completed' AND random() < 0.05 THEN
        INSERT INTO reviews (customer_id, order_id, customer_name, rating, comment, status, created_at)
        VALUES (cid, new_order, cname,
                (ARRAY[5,5,5,4,4,4,3,2])[1 + floor(random() * 8)::int],
                review_txt[1 + floor(random() * array_length(review_txt, 1))::int],
                'approved', at_ts + INTERVAL '2 hours');
        review_cnt := review_cnt + 1;
      END IF;
    END LOOP;

    d := d + 1;
  END LOOP;

  RAISE NOTICE 'Test data created: % orders, % reviews, 25 customers (% to %).',
    (SELECT COUNT(*) FROM orders WHERE customer_phone LIKE '000TEST%'), review_cnt, start_date, CURRENT_DATE - 1;
END $$;

-- Quick check: orders and paid revenue per month
SELECT TO_CHAR(created_at AT TIME ZONE 'Africa/Johannesburg', 'YYYY-MM') AS month,
       COUNT(*) AS orders,
       COUNT(*) FILTER (WHERE payment_status = 'paid') AS paid_orders,
       SUM(total_amount) FILTER (WHERE payment_status = 'paid') AS paid_revenue,
       COUNT(*) FILTER (WHERE refund_needed) AS refund_needed,
       COUNT(*) FILTER (WHERE payment_status IN ('awaiting','failed')) AS unpaid
FROM orders
WHERE customer_phone LIKE '000TEST%'
GROUP BY 1
ORDER BY 1;
