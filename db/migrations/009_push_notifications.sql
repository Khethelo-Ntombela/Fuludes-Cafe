-- =====================================================================
-- Push notifications (admin / kitchen / customer apps). These tables are
-- also created automatically on first use by functions/_lib/push.js;
-- running this just does it up front. Run in Neon SQL editor.
-- =====================================================================
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          SERIAL PRIMARY KEY,
  role        TEXT NOT NULL,                 -- 'admin' | 'staff' | 'customer'
  customer_id INTEGER,                       -- set for role = 'customer'
  endpoint    TEXT NOT NULL UNIQUE,          -- the browser's push service URL
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- VAPID key pair, generated once when VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY
-- aren't set in the environment.
CREATE TABLE IF NOT EXISTS push_config (
  id          INTEGER PRIMARY KEY DEFAULT 1,
  public_key  TEXT NOT NULL,
  private_key TEXT NOT NULL
);
