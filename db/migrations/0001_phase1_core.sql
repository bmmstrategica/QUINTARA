-- Quintara, migration 0001: the Phase 1 core.
-- Identity, membership, applications, the member directory, experiences and bookings,
-- notifications and the audit log. Later phases add their tables in later migrations
-- (the full target model is in docs/quintara_schema.sql).
-- Conventions: UUID keys, timestamptz everywhere, money in minor units, nothing tied to one city.

CREATE TABLE currencies (
  code        CHAR(3) PRIMARY KEY,
  name        TEXT NOT NULL,
  minor_units SMALLINT NOT NULL DEFAULT 2
);

CREATE TABLE countries (
  code CHAR(2) PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE cities (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  country_code CHAR(2) NOT NULL REFERENCES countries(code),
  name         TEXT NOT NULL,
  timezone     TEXT NOT NULL,
  UNIQUE (country_code, name)
);

CREATE TABLE markets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  city_id       UUID NOT NULL REFERENCES cities(id),
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  currency_code CHAR(3) NOT NULL REFERENCES currencies(code),
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT,                                   -- NULL while an applicant is still drafting
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'suspended', 'deleted')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email)) WHERE email IS NOT NULL AND deleted_at IS NULL;

-- Only a hash of the session token is stored, so a database leak cannot be replayed.
CREATE TABLE sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE roles (
  key      TEXT PRIMARY KEY,                           -- member, founder, investor, creator
  is_staff BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE user_roles (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_key   TEXT NOT NULL REFERENCES roles(key),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_key)
);

CREATE TABLE profiles (
  user_id           UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  full_name         TEXT NOT NULL,
  position          TEXT NOT NULL DEFAULT '',
  company           TEXT NOT NULL DEFAULT '',
  industry          TEXT NOT NULL DEFAULT '',
  city              TEXT NOT NULL DEFAULT '',
  biography         TEXT NOT NULL DEFAULT '',
  interests         TEXT[] NOT NULL DEFAULT '{}',
  looking_for       TEXT NOT NULL DEFAULT '',
  can_offer         TEXT NOT NULL DEFAULT '',
  show_in_directory BOOLEAN NOT NULL DEFAULT true,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE membership_tiers (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id      UUID NOT NULL REFERENCES markets(id),
  name           TEXT NOT NULL,
  price_minor    BIGINT NOT NULL DEFAULT 0 CHECK (price_minor >= 0),
  currency_code  CHAR(3) NOT NULL REFERENCES currencies(code),
  billing_period TEXT NOT NULL DEFAULT 'year' CHECK (billing_period IN ('month', 'year', 'once', 'none')),
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (market_id, name)
);

CREATE TABLE members (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL UNIQUE REFERENCES users(id),
  member_number  TEXT NOT NULL UNIQUE,
  home_market_id UUID NOT NULL REFERENCES markets(id),
  tier_id        UUID NOT NULL REFERENCES membership_tiers(id),
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'suspended', 'lapsed', 'resigned')),
  joined_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE membership_applications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id),
  market_id       UUID NOT NULL REFERENCES markets(id),
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'under_review', 'interview', 'approved', 'waitlisted', 'declined', 'payment_pending', 'active')),
  data            JSONB NOT NULL DEFAULT '{}'::jsonb,
  offered_tier_id UUID REFERENCES membership_tiers(id),
  submitted_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX applications_one_open_uq ON membership_applications (user_id) WHERE status NOT IN ('declined', 'active');
CREATE INDEX applications_queue_idx ON membership_applications (market_id, status, submitted_at);

CREATE TABLE connections (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id UUID NOT NULL REFERENCES members(id),
  addressee_id UUID NOT NULL REFERENCES members(id),
  status       TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'connected', 'declined', 'removed')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (requester_id <> addressee_id)
);
-- One row per pair of members, whichever way round it was requested.
CREATE UNIQUE INDEX connections_pair_uq ON connections (LEAST(requester_id, addressee_id), GREATEST(requester_id, addressee_id));

CREATE TABLE experiences (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id             UUID NOT NULL REFERENCES markets(id),
  title                 TEXT NOT NULL,
  category              TEXT NOT NULL,
  summary               TEXT NOT NULL DEFAULT '',
  description           TEXT NOT NULL DEFAULT '',
  starts_at             TIMESTAMPTZ NOT NULL,
  timezone              TEXT NOT NULL,                  -- where it happens, not where the viewer is
  venue_name            TEXT NOT NULL DEFAULT '',
  area                  TEXT NOT NULL DEFAULT '',
  dress_code            TEXT NOT NULL DEFAULT '',
  host                  TEXT NOT NULL DEFAULT '',
  programme             JSONB NOT NULL DEFAULT '[]'::jsonb,
  included              JSONB NOT NULL DEFAULT '[]'::jsonb,
  capacity              INTEGER NOT NULL CHECK (capacity > 0),
  seats_held            INTEGER NOT NULL DEFAULT 0 CHECK (seats_held >= 0),   -- allocated by staff outside the app
  price_minor           BIGINT NOT NULL DEFAULT 0 CHECK (price_minor >= 0),
  member_price_minor    BIGINT NOT NULL DEFAULT 0 CHECK (member_price_minor >= 0),
  currency_code         CHAR(3) NOT NULL REFERENCES currencies(code),
  admission             TEXT NOT NULL DEFAULT 'members_only' CHECK (admission IN ('open', 'members_only', 'invitation_only', 'application_required')),
  is_hidden             BOOLEAN NOT NULL DEFAULT false,
  guest_policy          TEXT NOT NULL DEFAULT '',
  max_seats_per_booking SMALLINT NOT NULL DEFAULT 1 CHECK (max_seats_per_booking >= 1),
  status                TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'cancelled', 'completed')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX experiences_calendar_idx ON experiences (market_id, starts_at) WHERE status = 'published';

CREATE TABLE experience_invitations (
  experience_id UUID NOT NULL REFERENCES experiences(id) ON DELETE CASCADE,
  member_id     UUID NOT NULL REFERENCES members(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (experience_id, member_id)
);

CREATE TABLE experience_bookings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  experience_id UUID NOT NULL REFERENCES experiences(id),
  member_id     UUID NOT NULL REFERENCES members(id),
  seats         SMALLINT NOT NULL CHECK (seats >= 1),
  status        TEXT NOT NULL CHECK (status IN ('applied', 'waitlisted', 'confirmed', 'cancelled', 'declined', 'attended')),
  ticket_code   TEXT NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- A member can hold at most one live booking per experience.
CREATE UNIQUE INDEX bookings_one_live_uq ON experience_bookings (experience_id, member_id) WHERE status IN ('applied', 'waitlisted', 'confirmed', 'attended');
CREATE INDEX bookings_member_idx ON experience_bookings (member_id);

CREATE TABLE notifications (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category   TEXT NOT NULL,
  title      TEXT NOT NULL,
  link       JSONB,
  read_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notifications_inbox_idx ON notifications (user_id, created_at DESC);

CREATE TABLE audit_logs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_user_id UUID REFERENCES users(id),
  action        TEXT NOT NULL,
  entity_type   TEXT,
  entity_id     UUID,
  changes       JSONB
);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id);

-- The audit log can be added to and read, never changed.
CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION forbid_change();
