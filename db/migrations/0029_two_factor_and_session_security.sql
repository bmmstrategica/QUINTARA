-- Two-factor authentication for every account, and tighter sessions.

-- The authenticator app (TOTP, RFC 6238). The secret is encrypted with MFA_ENCRYPTION_KEY (AES-256-GCM) and is
-- never sent back to any app after it has been set up. last_step stops a code being used twice.
CREATE TABLE user_mfa (
  user_id          UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  totp_secret_enc  TEXT NOT NULL,
  confirmed_at     TIMESTAMPTZ,                     -- NULL while being set up
  last_step        BIGINT NOT NULL DEFAULT 0,
  failed_attempts  INT NOT NULL DEFAULT 0,
  locked_until     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One-time recovery codes, for a lost phone. Only hashes are kept; each works once.
CREATE TABLE mfa_recovery_codes (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX mfa_recovery_codes_user_idx ON mfa_recovery_codes (user_id) WHERE used_at IS NULL;

-- A session is complete only once the second step is done. Until then it can do nothing but that step:
-- 'verify' (enter the code from the authenticator) or 'enrol' (set one up first).
ALTER TABLE sessions
  ADD COLUMN mfa_state     TEXT NOT NULL DEFAULT 'complete' CHECK (mfa_state IN ('complete', 'verify', 'enrol')),
  ADD COLUMN mfa_failures  INT NOT NULL DEFAULT 0,
  ADD COLUMN kind          TEXT NOT NULL DEFAULT 'app' CHECK (kind IN ('app', 'staff')),
  ADD COLUMN last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX sessions_user_live_idx ON sessions (user_id) WHERE revoked_at IS NULL;

-- A new authenticator being set up to replace a working one (a new phone). The old one keeps working until the
-- new one is confirmed with a code.
CREATE TABLE user_mfa_pending (
  user_id         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  totp_secret_enc TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
