-- Cities: staff open and close them. `is_active` is "open to the public"; a closed city is seen only by staff.
ALTER TABLE markets ADD COLUMN opened_at TIMESTAMPTZ;
ALTER TABLE markets ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
UPDATE markets SET opened_at = created_at WHERE is_active;
-- The directory is per city: members are listed in their home city.
CREATE INDEX IF NOT EXISTS members_home_market_idx ON members (home_market_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS experiences_market_idx ON experiences (market_id, starts_at);

-- A member's calendar, connected to QÉRA by choice. The private calendar address is stored encrypted and never
-- returned to any app. Events are kept only for the next week and erased when the calendar is disconnected.
CREATE TABLE calendar_connections (
  user_id         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL CHECK (provider IN ('google', 'apple', 'outlook', 'other', 'sample')),
  label           TEXT NOT NULL DEFAULT '' CHECK (char_length(label) <= 80),
  address_secret  TEXT,                         -- AES-256-GCM, base64; null for the sample calendar
  show_titles     BOOLEAN NOT NULL DEFAULT true,  -- false: QÉRA sees only that the time is busy
  connected_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  synced_at       TIMESTAMPTZ,
  sync_error      TEXT
);
CREATE TABLE calendar_events (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  uid        TEXT NOT NULL CHECK (char_length(uid) <= 300),
  starts_at  TIMESTAMPTZ NOT NULL,
  ends_at    TIMESTAMPTZ,
  all_day    BOOLEAN NOT NULL DEFAULT false,
  title      TEXT NOT NULL DEFAULT '' CHECK (char_length(title) <= 200),
  location   TEXT NOT NULL DEFAULT '' CHECK (char_length(location) <= 200),
  PRIMARY KEY (user_id, uid, starts_at)
);
CREATE INDEX calendar_events_user_idx ON calendar_events (user_id, starts_at);

-- The daily brief, on by default like the weekly one; members switch it off under Profile.
ALTER TABLE privacy_settings ADD COLUMN daily_brief BOOLEAN;

ALTER TABLE consent_events DROP CONSTRAINT consent_events_consent_key_check;
ALTER TABLE consent_events ADD CONSTRAINT consent_events_consent_key_check CHECK (consent_key IN ('directory_listing', 'marketing_email', 'suggestions', 'guest_terms', 'calendar'));
