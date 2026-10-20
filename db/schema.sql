-- Fulude's Cafe database schema for fresh installations.
-- Incremental changes are preserved in db/migrations/.

-- Menu
CREATE TABLE IF NOT EXISTS categories (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,        -- "Chicken"
  slug        TEXT NOT NULL UNIQUE,        -- "chicken"
  sort_order  INTEGER NOT NULL DEFAULT 0,  -- controls tab order
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS spice_levels (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,        -- "Mild", "Medium", "Hot", "Extra Hot"
  sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS addons (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  price       NUMERIC(10,2) NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS menu_items (
  id               SERIAL PRIMARY KEY,
  category_id      INTEGER NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  name             TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  price            NUMERIC(10,2) NOT NULL,
  special_price    NUMERIC(10,2),
  image_url        TEXT,
  is_available     BOOLEAN NOT NULL DEFAULT TRUE,
  stock_quantity   INTEGER,
  is_visible       BOOLEAN NOT NULL DEFAULT TRUE,
  accepts_spice    BOOLEAN NOT NULL DEFAULT FALSE,
  accepts_addons   BOOLEAN NOT NULL DEFAULT FALSE,
  drink_type       TEXT,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_menu_items_category ON menu_items(category_id);

-- Upgrade support for databases created from an earlier schema.
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS stock_quantity INTEGER;

ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS special_price NUMERIC(10,2);
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS special_starts_at TIMESTAMPTZ;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS special_ends_at TIMESTAMPTZ;
UPDATE menu_items SET stock_quantity = 0 WHERE is_available = FALSE AND stock_quantity IS NULL;

CREATE TABLE IF NOT EXISTS menu_item_images (
  id            SERIAL PRIMARY KEY,
  menu_item_id  INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  image_url     TEXT NOT NULL,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_menu_item_images_item ON menu_item_images(menu_item_id);

CREATE TABLE IF NOT EXISTS menu_item_addons (
  menu_item_id  INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  addon_id      INTEGER NOT NULL REFERENCES addons(id) ON DELETE CASCADE,
  PRIMARY KEY (menu_item_id, addon_id)
);

-- Optional sides
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

CREATE TABLE IF NOT EXISTS dish_ingredients (
  id               SERIAL PRIMARY KEY,
  menu_item_id     INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  ingredient_name  TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (menu_item_id, ingredient_name)
);
CREATE INDEX IF NOT EXISTS idx_dish_ingredients_item ON dish_ingredients(menu_item_id);
CREATE INDEX IF NOT EXISTS idx_dish_ingredients_name ON dish_ingredients(ingredient_name);

-- Customers and sessions
CREATE TABLE IF NOT EXISTS customers (
  id                    SERIAL PRIMARY KEY,
  name                  TEXT NOT NULL,
  email                 TEXT NOT NULL UNIQUE,
  password_hash         TEXT NOT NULL,
  password_salt         TEXT NOT NULL,
  google_id             TEXT,
  is_verified           BOOLEAN NOT NULL DEFAULT FALSE,
  phone_number          TEXT,
  delivery_address      TEXT,
  marketing_email_opt_in BOOLEAN NOT NULL DEFAULT FALSE,
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  is_locked             BOOLEAN NOT NULL DEFAULT FALSE, -- true after 4 failed logins in a row;
                                                          -- only a password reset clears this
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE customers ADD COLUMN IF NOT EXISTS google_id TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS is_verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS phone_number TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS delivery_address TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS marketing_email_opt_in BOOLEAN NOT NULL DEFAULT FALSE;
-- (SMS marketing was removed - see db/migrations/005_remove_sms_marketing.sql)

ALTER TABLE customers ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE customers ALTER COLUMN password_salt DROP NOT NULL;

CREATE TABLE IF NOT EXISTS customer_sessions (
  token         TEXT PRIMARY KEY,
  customer_id   INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days')
);

CREATE INDEX IF NOT EXISTS idx_customer_sessions_customer ON customer_sessions(customer_id);

CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT PRIMARY KEY,
  count        INTEGER NOT NULL DEFAULT 1,
  expires_at   TIMESTAMPTZ NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id           SERIAL PRIMARY KEY,
  actor_type   TEXT,
  actor_id     INTEGER,
  actor_role   TEXT,
  actor_name   TEXT,
  actor_ip     TEXT,
  action       TEXT NOT NULL,
  target_type  TEXT,
  target_id    INTEGER,
  details      JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS password_resets (
  token         TEXT PRIMARY KEY,
  customer_id   INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  expires_at    TIMESTAMPTZ NOT NULL,
  used          BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_password_resets_customer ON password_resets(customer_id);

CREATE TABLE IF NOT EXISTS password_change_requests (
  token         TEXT PRIMARY KEY,
  customer_id   INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  new_hash      TEXT NOT NULL,
  new_salt      TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  used          BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_password_change_requests_customer ON password_change_requests(customer_id);

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  token       TEXT PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_verification_customer ON email_verification_tokens(customer_id);

CREATE TABLE IF NOT EXISTS customer_reservations (
  id                      SERIAL PRIMARY KEY,
  customer_id             INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  customer_name           TEXT NOT NULL,
  customer_email          TEXT NOT NULL,
  customer_phone          TEXT NOT NULL,
  reservation_date       DATE NOT NULL,
  reservation_time       TIME NOT NULL,
  party_size             INTEGER NOT NULL,
  table_number           TEXT,
  notes                  TEXT,
  advance_order_requested BOOLEAN NOT NULL DEFAULT FALSE,
  advance_order_details  TEXT,
  advance_order_id       INTEGER,
  status                 TEXT NOT NULL DEFAULT 'Pending',
  admin_cleared          BOOLEAN NOT NULL DEFAULT FALSE,
  hidden_by_customer     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE customer_reservations ADD COLUMN IF NOT EXISTS admin_cleared BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_customer_reservations_customer ON customer_reservations(customer_id);

CREATE TABLE IF NOT EXISTS admin_accounts (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  username      TEXT,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  permissions JSONB NOT NULL DEFAULT '{"all": true}',
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  is_locked     BOOLEAN NOT NULL DEFAULT FALSE,
  email_verified BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE admin_accounts ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '{"all": true}';
ALTER TABLE admin_accounts ADD COLUMN IF NOT EXISTS username TEXT;
-- Two admins may not share a username (NULLs are exempt, so older accounts
-- that haven't set one yet don't conflict with each other).
CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_accounts_username ON admin_accounts(username) WHERE username IS NOT NULL;

CREATE TABLE IF NOT EXISTS admin_sessions (
  token TEXT PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES admin_accounts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '12 hours')
);

CREATE TABLE IF NOT EXISTS admin_password_resets (
  token         TEXT PRIMARY KEY,
  admin_id      INTEGER NOT NULL REFERENCES admin_accounts(id) ON DELETE CASCADE,
  expires_at    TIMESTAMPTZ NOT NULL,
  used          BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS staff_accounts (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  permissions JSONB NOT NULL DEFAULT '{"orders": true}',
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  is_locked     BOOLEAN NOT NULL DEFAULT FALSE,
  email_verified BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE staff_accounts ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '{"orders": true}';

CREATE TABLE IF NOT EXISTS staff_sessions (
  token TEXT PRIMARY KEY,
  staff_id INTEGER NOT NULL REFERENCES staff_accounts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '12 hours')
);


-- orders / order_items: checkout tickets
CREATE TABLE IF NOT EXISTS orders (
  id                SERIAL PRIMARY KEY,
  customer_id       INTEGER REFERENCES customers(id) ON DELETE SET NULL, -- who placed it (accounts are required to check out)
  customer_name     TEXT NOT NULL,
  customer_phone    TEXT NOT NULL,
  order_type        TEXT NOT NULL DEFAULT 'collection', -- 'collection' | 'delivery' | 'dine_in'
  delivery_address  TEXT,
  delivery_lat      NUMERIC(9,6),
  delivery_lng      NUMERIC(9,6),
  delivery_distance_km NUMERIC(6,2),
  delivery_fee      NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  table_number      TEXT,                                -- optional, only meaningful for dine_in
  pickup_time       TEXT NOT NULL DEFAULT 'As soon as possible',
  special_instructions TEXT,
  total_amount      NUMERIC(10,2) NOT NULL,
  status            TEXT NOT NULL DEFAULT 'New', -- New | Preparing | Ready | Collection | Delivery | Completed | Cancelled
  payment_method    TEXT NOT NULL DEFAULT 'online',
  payment_status    TEXT NOT NULL DEFAULT 'awaiting',
  payment_ref       TEXT,
  yoco_checkout_id  TEXT,
  payment_confirmed_at TIMESTAMPTZ,
  kitchen_release_at TIMESTAMPTZ,
  scheduled_for     TIMESTAMPTZ,
  preparing_at      TIMESTAMPTZ,
  out_for_delivery_at TIMESTAMPTZ,
  delivered_at      TIMESTAMPTZ,
  new_order_push_sent_at TIMESTAMPTZ,
  stock_decremented BOOLEAN NOT NULL DEFAULT FALSE,
  cancelled_by      TEXT,
  cancel_reason     TEXT,
  refund_needed     BOOLEAN NOT NULL DEFAULT FALSE,
  refund_processed_at TIMESTAMPTZ,
  refund_ref        TEXT,
  refund_error      TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Safe to re-run: adds the payment columns above to an orders table that
-- already existed from an earlier version of this schema.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT 'online';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'awaiting';
ALTER TABLE orders ALTER COLUMN payment_method SET DEFAULT 'online';
ALTER TABLE orders ALTER COLUMN payment_status SET DEFAULT 'awaiting';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_ref TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS yoco_checkout_id TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_lat NUMERIC(9,6);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_lng NUMERIC(9,6);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_distance_km NUMERIC(6,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_fee NUMERIC(10,2) NOT NULL DEFAULT 0.00;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_confirmed_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS kitchen_release_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS new_order_push_sent_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS stock_decremented BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_needed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_processed_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_ref TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_error TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_by TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancel_reason TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS preparing_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS out_for_delivery_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS table_number TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL;
ALTER TABLE customer_reservations ADD COLUMN IF NOT EXISTS advance_order_id INTEGER;
DO $$ BEGIN
  ALTER TABLE customer_reservations ADD CONSTRAINT customer_reservations_advance_order_fk
    FOREIGN KEY (advance_order_id) REFERENCES orders(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);

UPDATE orders SET status = 'New' WHERE status = 'Pending';
UPDATE orders SET status = 'Preparing' WHERE status = 'Acknowledged';
UPDATE orders SET status = 'Delivery' WHERE status = 'Out for Delivery';

CREATE TABLE IF NOT EXISTS order_items (
  id             SERIAL PRIMARY KEY,
  order_id       INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id   INTEGER REFERENCES menu_items(id) ON DELETE SET NULL,
  item_name      TEXT NOT NULL,      -- snapshot, survives menu edits/deletes
  item_price     NUMERIC(10,2) NOT NULL,
  quantity       INTEGER NOT NULL,
  spice_level    TEXT,
  extras         JSONB NOT NULL DEFAULT '[]', -- [{"name":"Extra Chips","price":25}]
  subtotal       NUMERIC(10,2) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

-- reviews: customer feedback wall, owner can reply
CREATE TABLE IF NOT EXISTS reviews (
  id            SERIAL PRIMARY KEY,
  customer_id   INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  order_id      INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  customer_name TEXT NOT NULL,
  rating        SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment       TEXT NOT NULL,
  owner_reply   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- moderation status: 'pending', 'approved', 'rejected'
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'approved';
-- why an admin rejected a review (shown to the customer, who can then edit it)
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(status);

-- app_config: single-row settings the admin panel toggles
CREATE TABLE IF NOT EXISTS app_config (
  id                 INTEGER PRIMARY KEY DEFAULT 1,
  is_buffet_visible  BOOLEAN NOT NULL DEFAULT FALSE,
  is_out_of_service  BOOLEAN NOT NULL DEFAULT FALSE,
  out_of_service_reason TEXT,
  announcement_message  TEXT,
  cafe_latitude      NUMERIC(9,6),
  cafe_longitude     NUMERIC(9,6),
  cafe_phone         TEXT,
  cafe_email         TEXT,
  CONSTRAINT single_row CHECK (id = 1)
);
ALTER TABLE app_config ADD COLUMN IF NOT EXISTS is_out_of_service BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE app_config ADD COLUMN IF NOT EXISTS out_of_service_reason TEXT;
ALTER TABLE app_config ADD COLUMN IF NOT EXISTS announcement_message TEXT;
ALTER TABLE app_config ADD COLUMN IF NOT EXISTS cafe_latitude NUMERIC(9,6);
ALTER TABLE app_config ADD COLUMN IF NOT EXISTS cafe_longitude NUMERIC(9,6);
ALTER TABLE app_config ADD COLUMN IF NOT EXISTS cafe_phone TEXT;
ALTER TABLE app_config ADD COLUMN IF NOT EXISTS cafe_email TEXT;
INSERT INTO app_config (id, is_buffet_visible, cafe_latitude, cafe_longitude, cafe_phone, cafe_email)
VALUES (1, FALSE, -22.98341, 30.35963, '+27 663 649 016', 'info@fuludescafe.co.za')
  ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS delivery_fee_bands (
  id          SERIAL PRIMARY KEY,
  up_to_km    INTEGER NOT NULL UNIQUE,
  fee         NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO delivery_fee_bands (up_to_km, fee, sort_order)
SELECT km, 0.00, km / 3 FROM generate_series(3, 51, 3) AS bands(km)
ON CONFLICT (up_to_km) DO NOTHING;

-- Payment links admins send when placing an order for a customer
CREATE TABLE IF NOT EXISTS payment_links (
  token        TEXT PRIMARY KEY,
  order_id     INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  checkout_url TEXT,
  expires_at   TIMESTAMPTZ NOT NULL,
  used         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE payment_links ADD COLUMN IF NOT EXISTS checkout_url TEXT;

-- buffet_events: scheduled buffet sessions customers can book
CREATE TABLE IF NOT EXISTS buffet_events (
  id            SERIAL PRIMARY KEY,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  event_date    TIMESTAMPTZ NOT NULL,
  capacity      INTEGER NOT NULL DEFAULT 30,
  price_cents   INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- publish flag and booking close time
ALTER TABLE buffet_events ADD COLUMN IF NOT EXISTS is_published BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE buffet_events ADD COLUMN IF NOT EXISTS booking_closes_at TIMESTAMPTZ;
ALTER TABLE buffet_events ADD COLUMN IF NOT EXISTS photos JSONB NOT NULL DEFAULT '[]';

-- bookings for buffet events
CREATE TABLE IF NOT EXISTS buffet_bookings (
  id            SERIAL PRIMARY KEY,
  event_id      INTEGER NOT NULL REFERENCES buffet_events(id) ON DELETE CASCADE,
  customer_id   INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  phone         TEXT,
  seats         INTEGER NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- booking lifecycle status: pending|confirmed|cancelled|expired (new bookings start as pending; admin confirms)
ALTER TABLE buffet_bookings ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'confirmed';

-- Seed menu defaults
INSERT INTO categories (name, slug, sort_order) VALUES
  ('Starters', 'starters', 1),
  ('Mains',    'mains',    2),
  ('Pizza',    'pizza',    3),
  ('Platters', 'platters', 4),
  ('Sides',    'sides',    5),
  ('Dessert',  'dessert',  6),
  ('Drinks',   'drinks',   7)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO spice_levels (name, sort_order) VALUES
  ('Mild', 1), ('Medium', 2), ('Hot', 3), ('Extra Hot', 4)
ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          SERIAL PRIMARY KEY,
  role        TEXT NOT NULL,
  customer_id INTEGER,
  endpoint    TEXT NOT NULL UNIQUE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS push_config (
  id          INTEGER PRIMARY KEY DEFAULT 1,
  public_key  TEXT NOT NULL,
  private_key TEXT NOT NULL
);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_by TEXT; -- customer | staff | admin (migration 010)
ALTER TABLE customer_reservations ADD COLUMN IF NOT EXISTS hidden_by_customer BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE admin_accounts ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE admin_accounts ADD COLUMN IF NOT EXISTS is_locked BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE admin_accounts ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE staff_accounts ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE staff_accounts ADD COLUMN IF NOT EXISTS is_locked BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE staff_accounts ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS admin_email_verifications (
  token       TEXT PRIMARY KEY,
  admin_id    INTEGER NOT NULL REFERENCES admin_accounts(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS staff_email_verifications (
  token       TEXT PRIMARY KEY,
  staff_id    INTEGER NOT NULL REFERENCES staff_accounts(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- customer_carts: a signed-in customer's cart
CREATE TABLE IF NOT EXISTS customer_carts (
  customer_id  INTEGER PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  items        JSONB NOT NULL DEFAULT '[]'::jsonb,
  version      INTEGER NOT NULL DEFAULT 1,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS yoco_webhooks (
  id          TEXT PRIMARY KEY,
  mode        TEXT,
  url         TEXT NOT NULL,
  secret      TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Every Yoco checkout opened for an order, with its amount and the order lines as priced at that moment.
-- If a customer pays on an earlier checkout, the payment is accepted at that checkout's price.
CREATE TABLE IF NOT EXISTS order_checkouts (
  checkout_id TEXT PRIMARY KEY,
  order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  amount      NUMERIC(10,2) NOT NULL,
  lines       JSONB NOT NULL DEFAULT '[]',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_order_checkouts_order ON order_checkouts(order_id);
