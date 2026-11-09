-- Paying for experiences: a paid booking holds its seats until it is paid, and a cancellation can be refunded.

ALTER TABLE experience_bookings DROP CONSTRAINT experience_bookings_status_check;
ALTER TABLE experience_bookings ADD CONSTRAINT experience_bookings_status_check
  CHECK (status IN ('applied', 'waitlisted', 'awaiting_payment', 'confirmed', 'cancelled', 'declined', 'attended'));
ALTER TABLE experience_bookings
  ADD COLUMN amount_due_minor BIGINT NOT NULL DEFAULT 0 CHECK (amount_due_minor >= 0),
  ADD COLUMN payment_due_at   TIMESTAMPTZ;          -- the seats are held until this moment

DROP INDEX bookings_one_live_uq;
CREATE UNIQUE INDEX bookings_one_live_uq ON experience_bookings (experience_id, member_id)
  WHERE status IN ('applied', 'waitlisted', 'awaiting_payment', 'confirmed', 'attended');

-- Set per experience by staff rather than fixed in code.
ALTER TABLE experiences
  ADD COLUMN payment_hold_minutes INT NOT NULL DEFAULT 30 CHECK (payment_hold_minutes BETWEEN 5 AND 10080),
  ADD COLUMN refund_hours         INT NOT NULL DEFAULT 48 CHECK (refund_hours >= 0);   -- full refund up to this long before the start

ALTER TABLE payments
  ADD COLUMN refunded_at        TIMESTAMPTZ,
  ADD COLUMN provider_refund_id TEXT;
CREATE INDEX payments_booking_idx ON payments (booking_id) WHERE booking_id IS NOT NULL;
