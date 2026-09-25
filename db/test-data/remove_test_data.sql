-- =====================================================================
-- Removes everything db/test-data/seed_8_months.sql created - and nothing
-- else. Neon console > SQL Editor > paste > Run.
--   test customers: email ends with @fulude-test.invalid
--   test orders:    customer_phone starts with 000TEST (their order items
--                   are removed with them)
-- =====================================================================
DELETE FROM reviews
WHERE customer_id IN (SELECT id FROM customers WHERE email LIKE '%@fulude-test.invalid');

DELETE FROM orders
WHERE customer_phone LIKE '000TEST%';

DELETE FROM customers
WHERE email LIKE '%@fulude-test.invalid';

-- Should all be 0 now
SELECT
  (SELECT COUNT(*) FROM orders WHERE customer_phone LIKE '000TEST%') AS test_orders_left,
  (SELECT COUNT(*) FROM customers WHERE email LIKE '%@fulude-test.invalid') AS test_customers_left;
