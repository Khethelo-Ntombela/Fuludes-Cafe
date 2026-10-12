-- Out-of-service switch + hero announcement message

ALTER TABLE app_config ADD COLUMN IF NOT EXISTS is_out_of_service BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE app_config ADD COLUMN IF NOT EXISTS out_of_service_reason TEXT;
ALTER TABLE app_config ADD COLUMN IF NOT EXISTS announcement_message TEXT;
