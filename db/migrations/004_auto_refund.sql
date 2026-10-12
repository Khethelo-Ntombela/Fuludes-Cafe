-- Support automatic Yoco refunds on customer self-cancellation

ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_ref TEXT;

-- Set when an automatic refund call to Yoco fails, so it's visible
-- alongside refund_needed rather than only in application logs.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_error TEXT;

-- payment_status already allows arbitrary TEXT (not an enum/CHECK
-- constraint), so no migration is needed to start writing the new
-- value 'refunded' into it - this comment just documents the addition:
-- awaiting | paid | failed | cancelled | refunded
