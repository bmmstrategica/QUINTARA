-- Quintara, migration 0002: staff roles, application review, payments and check-in.

-- Roles are reference data, so they belong in a migration rather than in sample data.
INSERT INTO roles (key, is_staff) VALUES
  ('member', false), ('founder', false), ('investor', false), ('creator', false),
  ('admin', true), ('concierge', true)
ON CONFLICT (key) DO NOTHING;

-- Membership numbers come from a sequence so two activations can never collide.
CREATE SEQUENCE member_number_seq START 2001;

ALTER TABLE membership_applications
  ADD COLUMN reviewed_by   UUID REFERENCES users(id),
  ADD COLUMN decision_note TEXT,
  ADD COLUMN decided_at    TIMESTAMPTZ;

ALTER TABLE experience_bookings
  ADD COLUMN checked_in_at TIMESTAMPTZ,
  ADD COLUMN checked_in_by UUID REFERENCES users(id);

-- No card data is ever stored: only the provider's reference for the payment.
CREATE TABLE payments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id),
  market_id           UUID NOT NULL REFERENCES markets(id),
  purpose             TEXT NOT NULL CHECK (purpose IN ('membership', 'experience', 'boutique', 'concierge', 'deposit', 'partner_service')),
  application_id      UUID REFERENCES membership_applications(id),
  booking_id          UUID REFERENCES experience_bookings(id),
  amount_minor        BIGINT NOT NULL CHECK (amount_minor > 0),
  refunded_minor      BIGINT NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0 AND refunded_minor <= amount_minor),
  currency_code       CHAR(3) NOT NULL REFERENCES currencies(code),
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed', 'refunded')),
  provider            TEXT NOT NULL,
  provider_payment_id TEXT,
  idempotency_key     TEXT NOT NULL UNIQUE,          -- a retried request can never charge twice
  failure_reason      TEXT,
  paid_at             TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX payments_user_idx ON payments (user_id, created_at DESC);
CREATE UNIQUE INDEX payments_provider_uq ON payments (provider, provider_payment_id) WHERE provider_payment_id IS NOT NULL;
