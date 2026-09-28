-- =====================================================================
-- Admin/staff accounts: lock after 4 failed sign-ins (only the main admin
-- can re-enable them), and new accounts must click an emailed link before
-- they can sign in. Existing accounts stay verified.
-- Also added on the fly by functions/_lib/accountLockout.js and
-- accountVerification.js. Run in Neon SQL editor.
-- =====================================================================
ALTER TABLE admin_accounts ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE admin_accounts ADD COLUMN IF NOT EXISTS is_locked BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE admin_accounts ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE staff_accounts ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE staff_accounts ADD COLUMN IF NOT EXISTS is_locked BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE staff_accounts ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS admin_email_verifications (
  token TEXT PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES admin_accounts(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS staff_email_verifications (
  token TEXT PRIMARY KEY,
  staff_id INTEGER NOT NULL REFERENCES staff_accounts(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
