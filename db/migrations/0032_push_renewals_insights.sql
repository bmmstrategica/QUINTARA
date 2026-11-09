-- Push notifications to members' phones, automatic membership renewals, and the weekly insights report.

/* ---------- Push notifications ---------- */

-- A phone that receives push notifications. It belongs to the app session that registered it: when that session
-- ends (signing out, signing out everywhere, a suspension, a two-factor reset) the phone receives nothing more.
CREATE TABLE push_devices (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id   UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  token        TEXT NOT NULL UNIQUE CHECK (char_length(token) BETWEEN 10 AND 300),
  platform     TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  device_name  TEXT NOT NULL DEFAULT '' CHECK (char_length(device_name) <= 80),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at  TIMESTAMPTZ,
  disabled_reason TEXT
);
CREATE INDEX push_devices_user_idx ON push_devices (user_id) WHERE disabled_at IS NULL;

-- What each person wants pushed. Without a row: everything, without details on the lock screen.
CREATE TABLE push_settings (
  user_id      UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  muted        TEXT[] NOT NULL DEFAULT '{}',
  show_details BOOLEAN NOT NULL DEFAULT false,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every notification is pushed once, after its transaction commits, by the push sender. Older ones are not pushed.
ALTER TABLE notifications
  ADD COLUMN push_state TEXT NOT NULL DEFAULT 'pending' CHECK (push_state IN ('pending', 'sending', 'sent', 'skipped', 'failed')),
  ADD COLUMN pushed_at  TIMESTAMPTZ;
UPDATE notifications SET push_state = 'skipped';
CREATE INDEX notifications_push_queue_idx ON notifications (created_at) WHERE push_state IN ('pending', 'sending');

/* ---------- Automatic membership renewals ---------- */

-- A card kept by the payment provider. Quintara holds only the provider's reference, the brand, the last four
-- digits and the expiry date: never the card number or the security code. One card per person.
CREATE TABLE payment_methods (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider       TEXT NOT NULL,
  provider_token TEXT NOT NULL CHECK (char_length(provider_token) BETWEEN 6 AND 200),
  brand          TEXT NOT NULL CHECK (char_length(brand) BETWEEN 2 AND 30),
  last4          CHAR(4) NOT NULL CHECK (last4 ~ '^[0-9]{4}$'),
  exp_month      INT NOT NULL CHECK (exp_month BETWEEN 1 AND 12),
  exp_year       INT NOT NULL CHECK (exp_year BETWEEN 2000 AND 2100),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at     TIMESTAMPTZ
);
CREATE UNIQUE INDEX payment_methods_one_per_user_uq ON payment_methods (user_id) WHERE removed_at IS NULL;

-- When the current term ends, and whether it renews by itself. A member whose term has ended keeps access for a
-- grace period while a renewal is being tried, then lapses (and loses every member permission) until renewed.
ALTER TABLE members
  ADD COLUMN term_ends_at            TIMESTAMPTZ,
  ADD COLUMN auto_renew              BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN renewal_attempts        INT NOT NULL DEFAULT 0 CHECK (renewal_attempts >= 0),
  ADD COLUMN next_renewal_attempt_at TIMESTAMPTZ,
  ADD COLUMN last_renewal_failure    TEXT,
  ADD COLUMN lapsed_at               TIMESTAMPTZ;

-- Members who joined before renewals: their term runs from when they joined, and nobody's first renewal comes
-- sooner than 30 days from this change, so no one lapses on the day it goes live.
UPDATE members m SET term_ends_at = GREATEST(m.joined_at + make_interval(months => t.months), now() + interval '30 days')
  FROM (SELECT id, COALESCE(term_months, CASE billing_period WHEN 'year' THEN 12 WHEN 'month' THEN 1 END) AS months FROM membership_tiers) t
 WHERE t.id = m.tier_id AND t.months IS NOT NULL;

-- Reminders sent for a term, so each is sent once even with several servers.
CREATE TABLE membership_notices (
  member_id    UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  term_ends_at TIMESTAMPTZ NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('reminder_30', 'reminder_7', 'lapsed')),
  sent_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, term_ends_at, kind)
);

-- Renewal payments name the member and the term they paid for.
ALTER TABLE payments DROP CONSTRAINT payments_purpose_check;
ALTER TABLE payments ADD CONSTRAINT payments_purpose_check CHECK (purpose IN ('membership', 'membership_renewal', 'experience', 'boutique', 'concierge', 'deposit', 'partner_service'));
ALTER TABLE payments
  ADD COLUMN member_id  UUID REFERENCES members(id),
  ADD COLUMN period_end TIMESTAMPTZ;
CREATE INDEX payments_member_idx ON payments (member_id, created_at DESC) WHERE member_id IS NOT NULL;

-- Choosing automatic renewal is recorded like the other consents.
ALTER TABLE consent_events DROP CONSTRAINT consent_events_consent_key_check;
ALTER TABLE consent_events ADD CONSTRAINT consent_events_consent_key_check CHECK (consent_key IN ('directory_listing', 'marketing_email', 'suggestions', 'guest_terms', 'calendar', 'whatsapp', 'auto_renew', 'push'));

/* ---------- The weekly insights report ---------- */

ALTER TABLE staff_accounts ADD COLUMN weekly_report BOOLEAN NOT NULL DEFAULT false;
-- One report per week, even with several servers.
CREATE TABLE insight_reports (
  week_start DATE PRIMARY KEY,
  sent_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  recipients INT NOT NULL DEFAULT 0
);
