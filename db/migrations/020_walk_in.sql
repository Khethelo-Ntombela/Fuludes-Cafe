-- 020: walk-in (in-restaurant) orders and open dine-in tabs.
-- Safe to run more than once. Existing orders stay exactly as they are: they all become order_source = 'online'.
--
--   order_source  'online' (website, as before) | 'walk_in' (captured by staff/admin at the cafe)
--   tab_id        a dine-in walk-in order ("round") belongs to a tab that is paid at the end
--   captured_by   name of the staff member / admin who captured a walk-in order
--
-- Walk-in payment values: payment_method 'card_machine'; payment_status 'paid',
-- 'tab_open' (round of a tab that isn't paid yet), 'void' (cancelled round of a closed tab)
-- or 'written_off' (tab the guests left without paying).

CREATE TABLE IF NOT EXISTS walkin_tabs (
  id               SERIAL PRIMARY KEY,
  table_number     TEXT NOT NULL,
  customer_name    TEXT,
  status           TEXT NOT NULL DEFAULT 'open', -- open | closed | written_off
  opened_by        TEXT,
  opened_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at        TIMESTAMPTZ,
  closed_by        TEXT,
  payment_ref      TEXT,
  write_off_reason TEXT
);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_source TEXT NOT NULL DEFAULT 'online';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tab_id INTEGER REFERENCES walkin_tabs(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS captured_by TEXT;

CREATE INDEX IF NOT EXISTS idx_orders_source_created ON orders (order_source, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_tab ON orders (tab_id) WHERE tab_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_walkin_tabs_open ON walkin_tabs (status) WHERE status = 'open';
