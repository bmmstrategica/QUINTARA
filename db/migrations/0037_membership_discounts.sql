-- Quintara, migration 0037: discounts on membership fees, granted by the committee when approving.
ALTER TABLE membership_applications
  ADD COLUMN discount_minor  BIGINT NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  ADD COLUMN discount_reason TEXT CHECK (discount_reason IS NULL OR char_length(discount_reason) <= 200);
