-- Sign-in by a one-time code sent by email. Only hashes are kept: of the address (to find the code) and of the code.
CREATE TABLE sign_in_codes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_hash  TEXT NOT NULL,
  purpose     TEXT NOT NULL CHECK (purpose IN ('sign_in', 'join', 'staff')),
  code_hash   TEXT NOT NULL,
  attempts    INT NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sign_in_codes_email_idx ON sign_in_codes (email_hash, purpose, created_at DESC);
