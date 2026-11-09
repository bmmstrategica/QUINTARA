-- Suggested introductions ("People to meet") are a form of profiling, so each member can switch them off.
ALTER TABLE privacy_settings ADD COLUMN suggestions BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE consent_events DROP CONSTRAINT consent_events_consent_key_check;
ALTER TABLE consent_events ADD CONSTRAINT consent_events_consent_key_check CHECK (consent_key IN ('directory_listing', 'marketing_email', 'suggestions'));
