-- Admin-editable business hours. NULL means "use the default schedule" built into functions/_lib/hours.js.
-- Shape: {"0":{"closed":false,"open":"09:00","close":"20:00"}, ... "6":{...}}  (0 = Sunday ... 6 = Saturday)
ALTER TABLE app_config ADD COLUMN IF NOT EXISTS business_hours JSONB;
