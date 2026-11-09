-- Section descriptions written by staff (QÉRA, The Club, Concierge and so on). A section with no row uses the
-- default wording in the apps.
CREATE TABLE section_copy (
  id           UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  key          TEXT PRIMARY KEY CHECK (key IN ('qera', 'club', 'concierge', 'lifestyle', 'privileges', 'boutique', 'bookings', 'messaging', 'curator')),
  summary      TEXT NOT NULL CHECK (char_length(summary) BETWEEN 2 AND 160),
  description  TEXT NOT NULL CHECK (char_length(description) BETWEEN 10 AND 1200),
  updated_by   UUID REFERENCES users(id),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
