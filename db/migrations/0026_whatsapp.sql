-- QÉRA on WhatsApp. A person links a number by sending a one-time code from it; the number is stored only as a keyed
-- hash (to find the account when a message arrives), encrypted (to reply), and its last four digits (to show).
CREATE TABLE whatsapp_links (
  user_id         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  status          TEXT NOT NULL CHECK (status IN ('pending', 'linked')),
  code_hash       TEXT,
  code_expires_at TIMESTAMPTZ,
  number_hash     TEXT UNIQUE,
  number_sealed   TEXT,
  number_last4    TEXT,
  linked_at       TIMESTAMPTZ,
  last_inbound_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (status = 'pending' OR (number_hash IS NOT NULL AND number_sealed IS NOT NULL))
);

-- Every message WhatsApp delivers is recorded once by its id, so a delivery WhatsApp repeats is handled once.
-- The text itself is kept only in the QÉRA conversation, never here.
CREATE TABLE whatsapp_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wamid       TEXT NOT NULL UNIQUE,
  direction   TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Which messages in the QÉRA conversation were written or answered on WhatsApp.
ALTER TABLE qera_messages ADD COLUMN channel TEXT NOT NULL DEFAULT 'app' CHECK (channel IN ('app', 'whatsapp'));

ALTER TABLE consent_events DROP CONSTRAINT consent_events_consent_key_check;
ALTER TABLE consent_events ADD CONSTRAINT consent_events_consent_key_check CHECK (consent_key IN ('directory_listing', 'marketing_email', 'suggestions', 'guest_terms', 'calendar', 'whatsapp'));
