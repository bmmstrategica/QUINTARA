-- Personal accounts for guests: people who are not members. A guest holds no member roles.
CREATE TABLE guest_accounts (
  user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  market_id   UUID NOT NULL REFERENCES markets(id),
  full_name   TEXT NOT NULL CHECK (char_length(full_name) BETWEEN 2 AND 80),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A guest's time with QÉRA, one row per guest per local day. Counted on the server, so a client cannot reset it.
CREATE TABLE qera_guest_usage (
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  usage_day     DATE NOT NULL,
  used_seconds  INTEGER NOT NULL DEFAULT 0 CHECK (used_seconds >= 0),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, usage_day)
);

-- Creating a guest account records agreement to the guest terms.
ALTER TABLE consent_events DROP CONSTRAINT consent_events_consent_key_check;
ALTER TABLE consent_events ADD CONSTRAINT consent_events_consent_key_check CHECK (consent_key IN ('directory_listing', 'marketing_email', 'suggestions', 'guest_terms'));

-- Staff choose, experience by experience, what guests and visitors can see. Until now that followed open admission.
ALTER TABLE experiences ADD COLUMN open_to_guests BOOLEAN NOT NULL DEFAULT false;
UPDATE experiences SET open_to_guests = true WHERE admission = 'open';
