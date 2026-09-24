-- =====================================================================
-- Fulude's Cafe — Neon Postgres schema
-- Run this once in the Neon SQL editor (or via `psql`) before deploying.
-- Free tier: Neon's free plan covers this comfortably for a single cafe.
-- =====================================================================

-- ---------------------------------------------------------------------
-- categories: the browsing tabs on the customer menu (Chicken, Ribs, ...)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS categories (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,        -- "Chicken"
  slug        TEXT NOT NULL UNIQUE,        -- "chicken"
  sort_order  INTEGER NOT NULL DEFAULT 0,  -- controls tab order
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------
-- spice_levels: global list an admin edits once, reused by any dish
-- that accepts a spice choice (e.g. wings, chicken).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS spice_levels (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,        -- "Mild", "Medium", "Hot", "Extra Hot"
  sort_order  INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------
-- addons: global list of paid extras/sides an admin manages once
-- (e.g. "Extra Chips R25", "Cheese Sauce R15"). Attached to individual
-- menu items via menu_item_addons so only relevant items show them.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS addons (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  price       NUMERIC(10,2) NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------
-- menu_items: the dishes themselves
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS menu_items (
  id               SERIAL PRIMARY KEY,
  category_id      INTEGER NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  name             TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  price            NUMERIC(10,2) NOT NULL,
  special_price    NUMERIC(10,2),                 -- NULL = not on special. When set, this is the
                                                    -- ACTUAL selling price (used for checkout and
                                                    -- decremented stock) - `price` above becomes the
                                                    -- "was" price shown struck through so customers
                                                    -- can see what they're saving. Admin sets/clears
                                                    -- this from the Specials tab.
  image_url        TEXT,                        -- R2 CDN URL
  is_available     BOOLEAN NOT NULL DEFAULT TRUE, -- "Sold Out" badge on the customer menu - now
                                                   -- data-driven (see stock_quantity) rather than
                                                   -- a manual toggle: derived automatically by
                                                   -- functions/api/admin/menu.js and decremented
                                                   -- automatically by functions/api/order.js
  stock_quantity   INTEGER,                        -- how many are left; NULL = not tracked, always
                                                     -- available (e.g. drinks the cafe never runs out
                                                     -- of). When set, hitting 0 auto-flips is_available
                                                     -- to false; admin can edit this number any time
                                                     -- to restock.
  is_visible       BOOLEAN NOT NULL DEFAULT TRUE, -- shows on customer menu at all
                                                   -- (used for desserts/seasonal items admin
                                                   -- flips on only when actually offered)
  accepts_spice    BOOLEAN NOT NULL DEFAULT FALSE, -- show spice-level picker on this item
  accepts_addons   BOOLEAN NOT NULL DEFAULT FALSE, -- show extras checkboxes on this item
  sort_order       INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_menu_items_category ON menu_items(category_id);

-- Safe to re-run: adds stock_quantity to a menu_items table that already
-- existed from an earlier version of this schema, and does a one-time
-- best-guess migration from the old manual is_available toggle - items
-- already marked sold out become tracked with 0 in stock; everything
-- else stays untracked/unlimited (NULL) so nobody has to enter a number
-- for dishes they never intended to count (like drinks).
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS stock_quantity INTEGER;

-- Safe to re-run: adds special_price for the Specials feature to a
-- menu_items table that already existed from an earlier version of this
-- schema. Nothing to backfill - every existing item just starts off with
-- no special (NULL), same as it was before this column existed.
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS special_price NUMERIC(10,2);
-- Scheduling for specials: optional start/end timestamps (TIMESTAMPTZ)
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS special_starts_at TIMESTAMPTZ;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS special_ends_at TIMESTAMPTZ;
UPDATE menu_items SET stock_quantity = 0 WHERE is_available = FALSE AND stock_quantity IS NULL;

-- ---------------------------------------------------------------------
-- menu_item_images: photo gallery per dish (up to a handful of photos).
-- menu_items.image_url stays in sync as a denormalized "cover photo"
-- (sort_order = 0) so the menu grid query doesn't need a join just to
-- show the thumbnail; the full set here powers the tap-to-enlarge
-- gallery on the customer site.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS menu_item_images (
  id            SERIAL PRIMARY KEY,
  menu_item_id  INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  image_url     TEXT NOT NULL,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_menu_item_images_item ON menu_item_images(menu_item_id);

-- ---------------------------------------------------------------------
-- menu_item_addons: which global addons apply to which dish
-- (admin ticks these when creating/editing an item)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS menu_item_addons (
  menu_item_id  INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  addon_id      INTEGER NOT NULL REFERENCES addons(id) ON DELETE CASCADE,
  PRIMARY KEY (menu_item_id, addon_id)
);

-- ---------------------------------------------------------------------
-- sides: FREE choice-of-side options (Chips / Pap / Rice ...), ticked per dish
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- customers: real accounts, required to check out. password_hash/salt
-- use PBKDF2-SHA256 via the Web Crypto API (functions/_lib/password.js) -
-- no bcrypt, since Cloudflare Workers can't use native/binary bindings.
-- ---------------------------------------------------------------------
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

-- Allow OAuth-only customers to exist without a stored password
ALTER TABLE customers ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE customers ALTER COLUMN password_salt DROP NOT NULL;

-- customer_sessions: one row per signed-in browser. "Stay signed in until
-- you sign out" just means this row has no expiry - it's only removed by
-- logout (functions/api/auth/logout.js) or a password reset, which wipes
-- every session for that account.
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
  actor_ip     TEXT,
  action       TEXT NOT NULL,
  target_type  TEXT,
  target_id    INTEGER,
  details      JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- password_resets: short-lived one-time tokens emailed to a customer by
-- functions/api/auth/forgot-password.js, redeemed by reset-password.js.
CREATE TABLE IF NOT EXISTS password_resets (
  token         TEXT PRIMARY KEY,
  customer_id   INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  expires_at    TIMESTAMPTZ NOT NULL,
  used          BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_password_resets_customer ON password_resets(customer_id);

-- password_change_requests: a signed-in customer asked to change their
-- password from Settings. The NEW password is hashed immediately and parked
-- here; it is only copied onto the customer row once they click the link
-- we emailed them (functions/api/auth/confirm-password-change.js). If the
-- link is never opened, the password never changes.
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
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE customer_reservations ADD COLUMN IF NOT EXISTS admin_cleared BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_customer_reservations_customer ON customer_reservations(customer_id);

CREATE TABLE IF NOT EXISTS admin_accounts (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  permissions JSONB NOT NULL DEFAULT '{"all": true}',
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE admin_accounts ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '{"all": true}';

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


-- ---------------------------------------------------------------------
-- orders / order_items: checkout tickets
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
  id                SERIAL PRIMARY KEY,
  customer_id       INTEGER REFERENCES customers(id) ON DELETE SET NULL, -- who placed it (accounts are required to check out)
  customer_name     TEXT NOT NULL,
  customer_phone    TEXT NOT NULL,
  order_type        TEXT NOT NULL DEFAULT 'collection', -- 'collection' | 'delivery' | 'dine_in'
  delivery_address  TEXT,
  table_number      TEXT,                                -- optional, only meaningful for dine_in
  pickup_time       TEXT NOT NULL DEFAULT 'As soon as possible',
  special_instructions TEXT,
  total_amount      NUMERIC(10,2) NOT NULL,
  status            TEXT NOT NULL DEFAULT 'New', -- New | Preparing | Ready | Collection | Delivery | Completed | Cancelled
                                                   -- (kitchen order lifecycle - see the Staff Portal
                                                   -- section of README.md)
  payment_method    TEXT NOT NULL DEFAULT 'pickup',   -- 'pickup' (pay in person) | 'online' (gateway)
  payment_status    TEXT NOT NULL DEFAULT 'not_required', -- not_required | awaiting | paid | failed | cancelled
  payment_ref       TEXT,                              -- gateway reference once paid
  payment_confirmed_at TIMESTAMPTZ,
  kitchen_release_at TIMESTAMPTZ,
  stock_decremented BOOLEAN NOT NULL DEFAULT FALSE,
refund_needed     BOOLEAN NOT NULL DEFAULT FALSE,     -- true when a paid order is cancelled and a manual refund is still owed
  refund_processed_at TIMESTAMPTZ,                      -- set when a refund has been completed outside the app
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Safe to re-run: adds the payment columns above to an orders table that
-- already existed from an earlier version of this schema.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT 'pickup';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'not_required';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_ref TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_confirmed_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS kitchen_release_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS stock_decremented BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_needed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_processed_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS table_number TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL;
ALTER TABLE customer_reservations ADD COLUMN IF NOT EXISTS advance_order_id INTEGER;
DO $$ BEGIN
  ALTER TABLE customer_reservations ADD CONSTRAINT customer_reservations_advance_order_fk
    FOREIGN KEY (advance_order_id) REFERENCES orders(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);

-- One-time rename of the old 2-stage status vocabulary to the new
-- 4-stage kitchen lifecycle used by the Staff Portal. Safe to re-run -
-- once renamed, these UPDATEs simply match zero rows.
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

-- ---------------------------------------------------------------------
-- reviews: customer feedback wall, owner can reply
-- ---------------------------------------------------------------------
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
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(status);

-- ---------------------------------------------------------------------
-- app_config: single-row settings the admin panel toggles
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_config (
  id                 INTEGER PRIMARY KEY DEFAULT 1,
  is_buffet_visible  BOOLEAN NOT NULL DEFAULT FALSE,
  is_out_of_service  BOOLEAN NOT NULL DEFAULT FALSE,
  out_of_service_reason TEXT,
  announcement_message  TEXT,
  CONSTRAINT single_row CHECK (id = 1)
);
ALTER TABLE app_config ADD COLUMN IF NOT EXISTS is_out_of_service BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE app_config ADD COLUMN IF NOT EXISTS out_of_service_reason TEXT;
ALTER TABLE app_config ADD COLUMN IF NOT EXISTS announcement_message TEXT;
INSERT INTO app_config (id, is_buffet_visible) VALUES (1, FALSE)
  ON CONFLICT (id) DO NOTHING;

-- Payment links: one-time or time-limited links admins can create
-- when building a cart on a customer's behalf. The link points to the
-- public paylink endpoint which returns a hosted-checkout payload.
CREATE TABLE IF NOT EXISTS payment_links (
  token        TEXT PRIMARY KEY,
  order_id     INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  expires_at   TIMESTAMPTZ NOT NULL,
  used         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------
-- buffet_events: scheduled buffet sessions customers can book
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- Seed the 7 categories for Fulude's Cafe (safe to re-run).
--
-- This replaces an earlier 14-category, protein-based list (Wings,
-- Chicken, Ribs, Beef, Stew, Seafood, Tilapia Fish, Tripe & Cow Heels,
-- etc.) with a simpler course-based list. Individual dishes (e.g.
-- "Tilapia Fish Stew", "Tripe & Pap") now just live under "Mains" - the
-- dish name carries that detail instead of the category.
--
-- The DELETE below cleans up the old protein-based categories on a
-- database that already ran the previous version of this file. It's
-- safe to re-run: categories.menu_items has ON DELETE RESTRICT, so this
-- only succeeds while no dish has been assigned to one of the old
-- categories yet - if any had, the DELETE would fail loudly instead of
-- silently losing menu items, and those dishes would need to be
-- reassigned to a new category first.
-- ---------------------------------------------------------------------
DELETE FROM categories
WHERE slug NOT IN ('starters', 'mains', 'pizza', 'platters', 'sides', 'dessert', 'drinks');

INSERT INTO categories (name, slug, sort_order) VALUES
  ('Starters', 'starters', 1),
  ('Mains',    'mains',    2),
  ('Pizza',    'pizza',    3),
  ('Platters', 'platters', 4),
  ('Sides',    'sides',    5),
  ('Dessert',  'dessert',  6),
  ('Drinks',   'drinks',   7)
ON CONFLICT (slug) DO NOTHING;

-- Starter spice levels (edit freely from the admin panel later)
INSERT INTO spice_levels (name, sort_order) VALUES
  ('Mild', 1), ('Medium', 2), ('Hot', 3), ('Extra Hot', 4)
ON CONFLICT (name) DO NOTHING;
