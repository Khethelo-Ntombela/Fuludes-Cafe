-- Saved carts: a signed-in customer's cart lives on their account

CREATE TABLE IF NOT EXISTS customer_carts (
  customer_id  INTEGER PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  items        JSONB NOT NULL DEFAULT '[]'::jsonb,
  version      INTEGER NOT NULL DEFAULT 1,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
