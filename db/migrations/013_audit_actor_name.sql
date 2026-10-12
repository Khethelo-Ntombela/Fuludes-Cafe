-- audit_logs.actor_name: the admin/staff username or name *at the time of the action*

ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS actor_name TEXT;

ALTER TABLE admin_accounts ADD COLUMN IF NOT EXISTS username TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_accounts_username ON admin_accounts(username) WHERE username IS NOT NULL;
