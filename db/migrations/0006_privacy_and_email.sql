-- Privacy (POPIA): consent records, account closure and erasure. Email: an outbox filled from notifications.

CREATE TABLE privacy_settings (
  user_id         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  marketing_email BOOLEAN NOT NULL DEFAULT false,      -- opt in, never assumed
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every change of consent, kept as evidence of what was agreed and when. Never updated.
CREATE TABLE consent_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  consent_key TEXT NOT NULL CHECK (consent_key IN ('directory_listing', 'marketing_email')),
  granted     BOOLEAN NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX consent_events_user_idx ON consent_events (user_id, occurred_at);

-- Closing an account ends access at once; personal data is erased after a cooling-off period.
CREATE TABLE account_closures (
  user_id      UUID PRIMARY KEY REFERENCES users(id),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  erase_after  TIMESTAMPTZ NOT NULL,
  erased_at    TIMESTAMPTZ
);
CREATE INDEX account_closures_due_idx ON account_closures (erase_after) WHERE erased_at IS NULL;

CREATE TABLE email_outbox (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category   TEXT NOT NULL,
  subject    TEXT NOT NULL,
  link       JSONB,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  attempts   INT NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at    TIMESTAMPTZ
);
CREATE INDEX email_outbox_pending_idx ON email_outbox (created_at) WHERE status = 'pending';

-- One rule for the whole system: whatever a person is notified of in the app is also emailed,
-- except promotional categories, which need their marketing consent.
CREATE FUNCTION queue_notification_email() RETURNS trigger AS $$
BEGIN
  IF NEW.category IN ('qera_recommendation', 'partner_privilege')
     AND NOT COALESCE((SELECT marketing_email FROM privacy_settings WHERE user_id = NEW.user_id), false) THEN
    RETURN NEW;
  END IF;
  INSERT INTO email_outbox (user_id, category, subject, link) VALUES (NEW.user_id, NEW.category, NEW.title, NEW.link);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER notifications_queue_email AFTER INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION queue_notification_email();
