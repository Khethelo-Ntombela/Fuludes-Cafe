-- Remove SMS marketing, add password-change confirmation table

ALTER TABLE customers DROP COLUMN IF EXISTS marketing_sms_opt_in;

-- Password changes from Settings must be confirmed by an emailed link.
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
