-- =====================================================================
-- Saved carts: a signed-in customer's cart lives on their account, so the
-- same cart shows on their phone, PC and tablet.
--
-- Only the customer's CHOICES are stored (dish id, quantity, spice level,
-- side id, extra ids) - never names or prices. Every time the cart is read
-- it is rebuilt from the live menu (functions/_lib/savedCart.js), so a
-- changed price is always current and sold-out dishes drop out.
--
-- version goes up on every change; a device compares it to see whether
-- the cart was changed somewhere else. A cart untouched for 30 days is
-- treated as empty. The cart is removed when an order is placed
-- (functions/api/order.js) and with the account (ON DELETE CASCADE).
--
-- Also created on the fly by functions/_lib/savedCart.js, so running this
-- is optional. Run in Neon SQL editor.
-- =====================================================================
CREATE TABLE IF NOT EXISTS customer_carts (
  customer_id  INTEGER PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  items        JSONB NOT NULL DEFAULT '[]'::jsonb,
  version      INTEGER NOT NULL DEFAULT 1,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
