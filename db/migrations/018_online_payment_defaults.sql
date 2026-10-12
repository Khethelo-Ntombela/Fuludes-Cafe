-- New orders use the online checkout flow by default

ALTER TABLE orders ALTER COLUMN payment_method SET DEFAULT 'online';
ALTER TABLE orders ALTER COLUMN payment_status SET DEFAULT 'awaiting';
