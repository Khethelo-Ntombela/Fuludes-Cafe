-- =====================================================================
-- audit_logs.actor_name: the admin/staff username or name *at the time
-- of the action*, so the audit log shows a person's name instead of
-- "admin #2" / "staff #2" - and old entries keep showing the name as it
-- was even if the account is later renamed or deleted.
--
-- admin_accounts.username: admins had no name/username at all before -
-- staff already had one (staff_accounts.name), which is what the audit
-- log now uses for staff entries.
--
-- Also added on the fly by functions/_lib/audit.js and
-- functions/api/admin/accounts.js so older databases keep working.
-- Run in Neon SQL editor.
-- =====================================================================
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS actor_name TEXT;

ALTER TABLE admin_accounts ADD COLUMN IF NOT EXISTS username TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_accounts_username ON admin_accounts(username) WHERE username IS NOT NULL;
