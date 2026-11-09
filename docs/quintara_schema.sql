-- =====================================================================
-- QUINTARA  |  PostgreSQL schema (v1 draft)
-- Conventions
--   * UUID primary keys (gen_random_uuid()).
--   * created_at / updated_at on mutable tables; updated_at kept by trigger.
--   * deleted_at = soft deletion. Unique rules use partial indexes so a
--     soft-deleted row never blocks a new one.
--   * Money is stored in minor units (cents) as BIGINT plus an ISO currency.
--   * Nothing is tied to Cape Town: every market-specific row carries
--     market_id, and all instants are TIMESTAMPTZ with the zone on the city.
--   * No card data, no passwords: only provider tokens / identity-provider ids.
--   * Row-level security is enabled on member data; the API sets
--     app.user_id / app.is_staff per request (see section 14).
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------------
-- 1. Reference data: currency, language, country, city, market
-- ---------------------------------------------------------------------
CREATE TABLE currencies (
  code         CHAR(3) PRIMARY KEY,                -- ISO 4217, e.g. ZAR
  name         TEXT NOT NULL,
  minor_units  SMALLINT NOT NULL DEFAULT 2 CHECK (minor_units BETWEEN 0 AND 4)
);

CREATE TABLE languages (
  code  VARCHAR(10) PRIMARY KEY,                   -- BCP 47, e.g. en-ZA
  name  TEXT NOT NULL
);

CREATE TABLE countries (
  code                  CHAR(2) PRIMARY KEY,       -- ISO 3166-1 alpha-2
  name                  TEXT NOT NULL,
  default_currency_code CHAR(3) NOT NULL REFERENCES currencies(code)
);

CREATE TABLE cities (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  country_code CHAR(2) NOT NULL REFERENCES countries(code),
  name         TEXT NOT NULL,
  timezone     TEXT NOT NULL,                      -- IANA, e.g. Africa/Johannesburg
  latitude     NUMERIC(9,6),
  longitude    NUMERIC(9,6),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (country_code, name)
);

-- A market is where Quintara operates (Cape Town first; Johannesburg, Dubai,
-- London ... later). Tiers, experiences, partners and prices hang off it.
CREATE TABLE markets (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  city_id               UUID NOT NULL REFERENCES cities(id),
  name                  TEXT NOT NULL UNIQUE,
  slug                  TEXT NOT NULL UNIQUE,
  default_currency_code CHAR(3) NOT NULL REFERENCES currencies(code),
  default_language_code VARCHAR(10) NOT NULL REFERENCES languages(code),
  is_active             BOOLEAN NOT NULL DEFAULT false,
  launched_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 2. Identity, roles, permissions, files
-- ---------------------------------------------------------------------
CREATE TYPE user_status AS ENUM ('pending', 'active', 'suspended', 'deleted');

CREATE TABLE users (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email              CITEXT NOT NULL,
  email_verified_at  TIMESTAMPTZ,
  phone_e164         TEXT,
  auth_subject       TEXT,                         -- id at the identity provider
  mfa_enabled        BOOLEAN NOT NULL DEFAULT false,
  status             user_status NOT NULL DEFAULT 'pending',
  language_code      VARCHAR(10) REFERENCES languages(code),
  timezone           TEXT,
  last_login_at      TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at         TIMESTAMPTZ
);
CREATE UNIQUE INDEX users_email_uq        ON users (email)        WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX users_auth_subject_uq ON users (auth_subject) WHERE auth_subject IS NOT NULL;

CREATE TABLE roles (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key         TEXT NOT NULL UNIQUE,                -- member, founder, investor, creator, concierge, admin ...
  name        TEXT NOT NULL,
  is_staff    BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE permissions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key         TEXT NOT NULL UNIQUE,                -- e.g. experiences.manage, qera.tool.search_members
  description TEXT
);

CREATE TABLE role_permissions (
  role_id       UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

-- Roles stack. market_id NULL = the role applies in every market.
CREATE TABLE user_roles (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id     UUID NOT NULL REFERENCES roles(id),
  market_id   UUID REFERENCES markets(id),
  granted_by  UUID REFERENCES users(id),
  verified_at TIMESTAMPTZ,                         -- e.g. investor verification
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at  TIMESTAMPTZ
);
CREATE UNIQUE INDEX user_roles_uq ON user_roles (user_id, role_id, COALESCE(market_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE revoked_at IS NULL;
CREATE INDEX user_roles_user_idx ON user_roles (user_id) WHERE revoked_at IS NULL;

CREATE TABLE admin_users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL UNIQUE REFERENCES users(id),
  job_title   TEXT,
  scope       TEXT NOT NULL CHECK (scope IN ('administrator', 'concierge', 'community', 'finance', 'content')),
  market_id   UUID REFERENCES markets(id),         -- NULL = all markets
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);

-- Every upload goes through this table: private bucket, virus scan, signed URLs.
CREATE TABLE files (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id  UUID REFERENCES users(id),
  storage_key    TEXT NOT NULL UNIQUE,
  purpose        TEXT NOT NULL CHECK (purpose IN ('profile_photo', 'message_attachment', 'pitch_material', 'experience_media', 'partner_media', 'product_media', 'invoice', 'other')),
  mime_type      TEXT NOT NULL,
  size_bytes     BIGINT NOT NULL CHECK (size_bytes > 0),
  checksum_sha256 TEXT,
  scan_status    TEXT NOT NULL DEFAULT 'pending' CHECK (scan_status IN ('pending', 'clean', 'infected', 'failed')),
  is_confidential BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ
);
CREATE INDEX files_owner_idx ON files (owner_user_id);

CREATE TABLE profiles (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  full_name           TEXT NOT NULL,
  photo_file_id       UUID REFERENCES files(id),
  industry            TEXT,
  company             TEXT,
  position            TEXT,
  city_id             UUID REFERENCES cities(id),  -- member location
  biography           TEXT,
  interests           TEXT[] NOT NULL DEFAULT '{}',
  expertise           TEXT[] NOT NULL DEFAULT '{}',
  looking_for         TEXT,
  can_offer           TEXT,
  social_links        JSONB NOT NULL DEFAULT '{}'::jsonb,
  fundraising_status  TEXT CHECK (fundraising_status IN ('not_raising', 'open_to_conversations', 'raising')),
  show_in_directory   BOOLEAN NOT NULL DEFAULT true,
  show_attendance     BOOLEAN NOT NULL DEFAULT false,
  search_vector       TSVECTOR,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at          TIMESTAMPTZ
);
CREATE INDEX profiles_city_idx      ON profiles (city_id);
CREATE INDEX profiles_interests_idx ON profiles USING GIN (interests);
CREATE INDEX profiles_search_idx    ON profiles USING GIN (search_vector);

-- ---------------------------------------------------------------------
-- 3. Membership
-- ---------------------------------------------------------------------
CREATE TYPE member_status AS ENUM ('active', 'paused', 'suspended', 'lapsed', 'resigned');

CREATE TABLE members (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL UNIQUE REFERENCES users(id),
  member_number   TEXT NOT NULL UNIQUE,
  home_market_id  UUID NOT NULL REFERENCES markets(id),
  status          member_status NOT NULL DEFAULT 'active',
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  card_secret     TEXT NOT NULL DEFAULT encode(gen_random_bytes(16), 'hex'),  -- signs the rotating QR
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);
CREATE INDEX members_market_status_idx ON members (home_market_id, status);

CREATE TABLE member_notes (                        -- staff only, never returned to members
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id     UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  author_id     UUID NOT NULL REFERENCES admin_users(id),
  body          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);
CREATE INDEX member_notes_member_idx ON member_notes (member_id);

CREATE TABLE membership_tiers (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id            UUID NOT NULL REFERENCES markets(id),
  name                 TEXT NOT NULL,
  kind                 TEXT NOT NULL CHECK (kind IN ('standard', 'founding', 'invited', 'complimentary', 'corporate', 'international')),
  price_minor          BIGINT NOT NULL DEFAULT 0 CHECK (price_minor >= 0),
  currency_code        CHAR(3) NOT NULL REFERENCES currencies(code),
  billing_period       TEXT NOT NULL CHECK (billing_period IN ('month', 'year', 'once', 'none')),
  guest_allowance      SMALLINT NOT NULL DEFAULT 0 CHECK (guest_allowance >= 0),
  experience_priority  SMALLINT NOT NULL DEFAULT 0,          -- higher books first
  concierge_access     TEXT NOT NULL DEFAULT 'desk' CHECK (concierge_access IN ('none', 'desk', 'dedicated')),
  benefits             JSONB NOT NULL DEFAULT '[]'::jsonb,
  access_rules         JSONB NOT NULL DEFAULT '{}'::jsonb,
  seats                SMALLINT NOT NULL DEFAULT 1 CHECK (seats >= 1),   -- >1 for corporate
  is_active            BOOLEAN NOT NULL DEFAULT true,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at           TIMESTAMPTZ
);
CREATE UNIQUE INDEX membership_tiers_name_uq ON membership_tiers (market_id, lower(name)) WHERE deleted_at IS NULL;

CREATE TYPE membership_status AS ENUM ('payment_pending', 'active', 'past_due', 'paused', 'cancelled', 'expired');

CREATE TABLE memberships (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id              UUID NOT NULL REFERENCES members(id),
  tier_id                UUID NOT NULL REFERENCES membership_tiers(id),
  status                 membership_status NOT NULL DEFAULT 'payment_pending',
  sponsor_membership_id  UUID REFERENCES memberships(id),   -- corporate parent, if any
  starts_at              TIMESTAMPTZ,
  current_period_end     TIMESTAMPTZ,
  cancelled_at           TIMESTAMPTZ,
  provider_subscription_id TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (current_period_end IS NULL OR starts_at IS NULL OR current_period_end > starts_at)
);
CREATE UNIQUE INDEX memberships_one_live_uq ON memberships (member_id) WHERE status IN ('payment_pending', 'active', 'past_due', 'paused');
CREATE INDEX memberships_tier_idx    ON memberships (tier_id);
CREATE INDEX memberships_renewal_idx ON memberships (current_period_end) WHERE status = 'active';

CREATE TYPE application_status AS ENUM ('draft', 'submitted', 'under_review', 'interview', 'approved', 'waitlisted', 'declined', 'payment_pending', 'active');

CREATE TABLE membership_applications (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id),
  market_id           UUID NOT NULL REFERENCES markets(id),
  status              application_status NOT NULL DEFAULT 'draft',
  personal            JSONB NOT NULL DEFAULT '{}'::jsonb,
  professional        JSONB NOT NULL DEFAULT '{}'::jsonb,
  interests           TEXT[] NOT NULL DEFAULT '{}',
  motivation          TEXT,
  requested_roles     TEXT[] NOT NULL DEFAULT '{}',          -- founder, investor, creator
  referred_by_member_id UUID REFERENCES members(id),
  invitation_code     TEXT,
  links               JSONB NOT NULL DEFAULT '{}'::jsonb,
  photo_file_id       UUID REFERENCES files(id),
  offered_tier_id     UUID REFERENCES membership_tiers(id),
  reviewed_by         UUID REFERENCES admin_users(id),
  decision_note       TEXT,
  submitted_at        TIMESTAMPTZ,
  decided_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at          TIMESTAMPTZ
);
CREATE UNIQUE INDEX applications_one_open_uq ON membership_applications (user_id, market_id) WHERE status NOT IN ('declined', 'active') AND deleted_at IS NULL;
CREATE INDEX applications_queue_idx ON membership_applications (market_id, status, submitted_at);

-- ---------------------------------------------------------------------
-- 4. Members club: connections, blocks, reports, messaging
-- ---------------------------------------------------------------------
CREATE TABLE connections (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id  UUID NOT NULL REFERENCES members(id),
  addressee_id  UUID NOT NULL REFERENCES members(id),
  status        TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'connected', 'declined', 'removed')),
  responded_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (requester_id <> addressee_id)
);
-- one row per pair, whichever way round it was requested
CREATE UNIQUE INDEX connections_pair_uq ON connections (LEAST(requester_id, addressee_id), GREATEST(requester_id, addressee_id));
CREATE INDEX connections_addressee_idx ON connections (addressee_id, status);

CREATE TABLE member_follows (
  follower_id  UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  followed_id  UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followed_id),
  CHECK (follower_id <> followed_id)
);

CREATE TABLE user_blocks (
  blocker_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);

CREATE TABLE reports (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id   UUID NOT NULL REFERENCES users(id),
  subject_type  TEXT NOT NULL CHECK (subject_type IN ('user', 'message', 'opportunity', 'product', 'video')),
  subject_id    UUID NOT NULL,
  reason        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewing', 'actioned', 'dismissed')),
  handled_by    UUID REFERENCES admin_users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX reports_queue_idx ON reports (status, created_at);

CREATE TABLE conversations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        TEXT NOT NULL CHECK (kind IN ('direct', 'experience_group', 'concierge')),
  title       TEXT,
  context_id  UUID,                                -- experience or concierge request, by kind
  created_by  UUID REFERENCES users(id),
  last_message_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);
CREATE INDEX conversations_context_idx ON conversations (kind, context_id);

CREATE TABLE conversation_participants (
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id),
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at         TIMESTAMPTZ,
  last_read_at    TIMESTAMPTZ,                     -- drives read status
  is_muted        BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX conversation_participants_user_idx ON conversation_participants (user_id) WHERE left_at IS NULL;

CREATE TABLE messages (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id        UUID NOT NULL REFERENCES users(id),
  body             TEXT,
  search_vector    TSVECTOR,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  edited_at        TIMESTAMPTZ,
  deleted_at       TIMESTAMPTZ
);
CREATE INDEX messages_thread_idx ON messages (conversation_id, created_at DESC);
CREATE INDEX messages_search_idx ON messages USING GIN (search_vector);

CREATE TABLE message_attachments (
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  file_id    UUID NOT NULL REFERENCES files(id),
  PRIMARY KEY (message_id, file_id)
);

-- ---------------------------------------------------------------------
-- 5. Partners, services, benefits
-- ---------------------------------------------------------------------
CREATE TABLE partners (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id      UUID NOT NULL REFERENCES markets(id),
  name           TEXT NOT NULL,
  slug           TEXT NOT NULL,
  category       TEXT NOT NULL,
  description    TEXT,
  contact        JSONB NOT NULL DEFAULT '{}'::jsonb,       -- staff only
  can_verify_members BOOLEAN NOT NULL DEFAULT false,
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'ended')),
  search_vector  TSVECTOR,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ
);
CREATE UNIQUE INDEX partners_slug_uq ON partners (market_id, slug) WHERE deleted_at IS NULL;
CREATE INDEX partners_browse_idx ON partners (market_id, category) WHERE status = 'active';
CREATE INDEX partners_search_idx ON partners USING GIN (search_vector);

CREATE TABLE partner_locations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id  UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  city_id     UUID NOT NULL REFERENCES cities(id),
  label       TEXT,
  address     TEXT,
  latitude    NUMERIC(9,6),
  longitude   NUMERIC(9,6),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX partner_locations_city_idx ON partner_locations (city_id);

-- A service is something the concierge can arrange, with or without a partner.
CREATE TABLE services (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id    UUID NOT NULL REFERENCES markets(id),
  partner_id   UUID REFERENCES partners(id),
  category     TEXT NOT NULL,                      -- hospitality, travel, wellness ...
  name         TEXT NOT NULL,
  description  TEXT,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ
);
CREATE INDEX services_browse_idx ON services (market_id, category) WHERE is_active;

CREATE TABLE partner_benefits (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id       UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  benefit_type     TEXT NOT NULL CHECK (benefit_type IN ('preferred_rate', 'upgrade', 'priority_booking', 'vip_access', 'complimentary_service', 'private_invitation', 'offer')),
  description      TEXT,
  eligible_tier_ids UUID[] NOT NULL DEFAULT '{}',  -- empty = every tier
  eligible_role_keys TEXT[] NOT NULL DEFAULT '{}', -- empty = every member
  valid_from       TIMESTAMPTZ,
  valid_until      TIMESTAMPTZ,
  usage_limit      INTEGER CHECK (usage_limit IS NULL OR usage_limit > 0),   -- per member
  redemption_code  TEXT,
  is_active        BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ,
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until > valid_from)
);
CREATE INDEX partner_benefits_partner_idx ON partner_benefits (partner_id) WHERE is_active;

CREATE TABLE benefit_redemptions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  benefit_id   UUID NOT NULL REFERENCES partner_benefits(id),
  member_id    UUID NOT NULL REFERENCES members(id),
  redeemed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_by_partner_id UUID REFERENCES partners(id)
);
CREATE INDEX benefit_redemptions_idx ON benefit_redemptions (benefit_id, member_id);

-- ---------------------------------------------------------------------
-- 6. Experiences
-- ---------------------------------------------------------------------
CREATE TYPE experience_admission AS ENUM ('open', 'members_only', 'invitation_only', 'application_required');
CREATE TYPE experience_status    AS ENUM ('draft', 'published', 'cancelled', 'completed');
CREATE TYPE booking_status       AS ENUM ('applied', 'pending_payment', 'confirmed', 'cancelled', 'declined', 'attended', 'no_show');

CREATE TABLE experiences (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id          UUID NOT NULL REFERENCES markets(id),
  city_id            UUID NOT NULL REFERENCES cities(id),   -- experience location (may differ from the market: retreats, travel)
  slug               TEXT NOT NULL,
  title              TEXT NOT NULL,
  category           TEXT NOT NULL,
  summary            TEXT,
  description        TEXT,
  hero_file_id       UUID REFERENCES files(id),
  starts_at          TIMESTAMPTZ NOT NULL,
  ends_at            TIMESTAMPTZ,
  venue_name         TEXT,
  address            TEXT,
  latitude           NUMERIC(9,6),
  longitude          NUMERIC(9,6),
  dress_code         TEXT,
  host_member_id     UUID REFERENCES members(id),
  programme          JSONB NOT NULL DEFAULT '[]'::jsonb,
  included_services  JSONB NOT NULL DEFAULT '[]'::jsonb,
  capacity           INTEGER NOT NULL CHECK (capacity > 0),
  price_minor        BIGINT NOT NULL DEFAULT 0 CHECK (price_minor >= 0),
  member_price_minor BIGINT NOT NULL DEFAULT 0 CHECK (member_price_minor >= 0),
  currency_code      CHAR(3) NOT NULL REFERENCES currencies(code),
  admission          experience_admission NOT NULL DEFAULT 'members_only',
  is_hidden          BOOLEAN NOT NULL DEFAULT false,
  guest_policy       TEXT,
  max_seats_per_booking SMALLINT NOT NULL DEFAULT 1 CHECK (max_seats_per_booking >= 1),
  waitlist_enabled   BOOLEAN NOT NULL DEFAULT true,
  status             experience_status NOT NULL DEFAULT 'draft',
  search_vector      TSVECTOR,
  created_by         UUID REFERENCES admin_users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at         TIMESTAMPTZ,
  CHECK (ends_at IS NULL OR ends_at > starts_at)
);
CREATE UNIQUE INDEX experiences_slug_uq ON experiences (market_id, slug) WHERE deleted_at IS NULL;
CREATE INDEX experiences_calendar_idx ON experiences (market_id, starts_at) WHERE status = 'published' AND deleted_at IS NULL;
CREATE INDEX experiences_category_idx ON experiences (category);
CREATE INDEX experiences_search_idx   ON experiences USING GIN (search_vector);

CREATE TABLE experience_partners (
  experience_id UUID NOT NULL REFERENCES experiences(id) ON DELETE CASCADE,
  partner_id    UUID NOT NULL REFERENCES partners(id),
  role          TEXT,
  PRIMARY KEY (experience_id, partner_id)
);

CREATE TABLE experience_invitations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  experience_id  UUID NOT NULL REFERENCES experiences(id) ON DELETE CASCADE,
  member_id      UUID NOT NULL REFERENCES members(id),
  invited_by     UUID REFERENCES admin_users(id),
  status         TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'accepted', 'declined', 'revoked')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (experience_id, member_id)
);

CREATE TABLE experience_bookings (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  experience_id    UUID NOT NULL REFERENCES experiences(id),
  member_id        UUID NOT NULL REFERENCES members(id),
  seats            SMALLINT NOT NULL DEFAULT 1 CHECK (seats >= 1),
  status           booking_status NOT NULL,
  unit_price_minor BIGINT NOT NULL DEFAULT 0 CHECK (unit_price_minor >= 0),
  currency_code    CHAR(3) NOT NULL REFERENCES currencies(code),
  ticket_code      TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(9), 'hex'),
  application_note TEXT,
  source           TEXT NOT NULL DEFAULT 'member' CHECK (source IN ('member', 'qera', 'concierge', 'admin')),
  checked_in_at    TIMESTAMPTZ,
  checked_in_by    UUID REFERENCES admin_users(id),
  cancelled_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX bookings_one_live_uq ON experience_bookings (experience_id, member_id) WHERE status IN ('applied', 'pending_payment', 'confirmed', 'attended');
CREATE INDEX bookings_member_idx     ON experience_bookings (member_id, status);
CREATE INDEX bookings_guest_list_idx ON experience_bookings (experience_id, status);
-- Capacity is enforced in the booking service inside a transaction that locks
-- the experience row (SELECT ... FOR UPDATE) and sums confirmed seats.

CREATE TABLE experience_guests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id    UUID NOT NULL REFERENCES experience_bookings(id) ON DELETE CASCADE,
  full_name     TEXT NOT NULL,
  email         CITEXT,
  guest_user_id UUID REFERENCES users(id),
  ticket_code   TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(9), 'hex'),
  checked_in_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX experience_guests_booking_idx ON experience_guests (booking_id);

CREATE TABLE waitlists (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  experience_id  UUID NOT NULL REFERENCES experiences(id) ON DELETE CASCADE,
  member_id      UUID NOT NULL REFERENCES members(id),
  seats          SMALLINT NOT NULL DEFAULT 1 CHECK (seats >= 1),
  priority       SMALLINT NOT NULL DEFAULT 0,      -- copied from the tier at join time
  status         TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'offered', 'accepted', 'expired', 'left')),
  offered_at     TIMESTAMPTZ,
  offer_expires_at TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (experience_id, member_id)
);
CREATE INDEX waitlists_queue_idx ON waitlists (experience_id, priority DESC, created_at) WHERE status = 'waiting';

-- ---------------------------------------------------------------------
-- 7. Concierge
-- ---------------------------------------------------------------------
CREATE TYPE concierge_status AS ENUM ('requested', 'reviewing', 'options_provided', 'confirmed', 'completed', 'cancelled');

CREATE TABLE concierge_requests (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id        UUID NOT NULL REFERENCES members(id),
  market_id        UUID NOT NULL REFERENCES markets(id),
  service_id       UUID REFERENCES services(id),
  partner_id       UUID REFERENCES partners(id),
  category         TEXT NOT NULL,
  subject          TEXT NOT NULL,
  details          TEXT NOT NULL,
  needed_by        TIMESTAMPTZ,
  status           concierge_status NOT NULL DEFAULT 'requested',
  assigned_to      UUID REFERENCES admin_users(id),
  conversation_id  UUID REFERENCES conversations(id),
  source           TEXT NOT NULL DEFAULT 'member' CHECK (source IN ('member', 'qera', 'admin')),
  quoted_minor     BIGINT CHECK (quoted_minor IS NULL OR quoted_minor >= 0),
  currency_code    CHAR(3) REFERENCES currencies(code),
  completed_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ
);
CREATE INDEX concierge_member_idx ON concierge_requests (member_id, created_at DESC);
CREATE INDEX concierge_queue_idx  ON concierge_requests (market_id, status, created_at) WHERE status NOT IN ('completed', 'cancelled');
CREATE INDEX concierge_assignee_idx ON concierge_requests (assigned_to) WHERE status NOT IN ('completed', 'cancelled');

CREATE TABLE concierge_request_events (            -- status history
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id  UUID NOT NULL REFERENCES concierge_requests(id) ON DELETE CASCADE,
  from_status concierge_status,
  to_status   concierge_status NOT NULL,
  actor_id    UUID REFERENCES users(id),
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX concierge_events_idx ON concierge_request_events (request_id, created_at);

-- ---------------------------------------------------------------------
-- 8. Opportunities and introductions (controlled, never a marketplace)
-- ---------------------------------------------------------------------
CREATE TABLE opportunities (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id        UUID NOT NULL REFERENCES markets(id),
  type             TEXT NOT NULL CHECK (type IN ('business_collaboration', 'founder', 'investment_introduction', 'brand_partnership', 'creator', 'sponsorship', 'speaking', 'job', 'advisory')),
  title            TEXT NOT NULL,
  summary          TEXT NOT NULL,
  posted_by_member_id UUID REFERENCES members(id),          -- NULL = Quintara
  visible_to_role_keys TEXT[] NOT NULL DEFAULT '{member}',   -- who may see it at all
  status           TEXT NOT NULL DEFAULT 'pending_review' CHECK (status IN ('draft', 'pending_review', 'published', 'closed', 'rejected')),
  approved_by      UUID REFERENCES admin_users(id),
  closes_at        TIMESTAMPTZ,
  search_vector    TSVECTOR,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ
);
CREATE INDEX opportunities_browse_idx ON opportunities (market_id, type) WHERE status = 'published' AND deleted_at IS NULL;
CREATE INDEX opportunities_roles_idx  ON opportunities USING GIN (visible_to_role_keys);
CREATE INDEX opportunities_search_idx ON opportunities USING GIN (search_vector);

-- Confidential documents are released per person, by staff, after consent.
CREATE TABLE opportunity_documents (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id UUID NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  file_id        UUID NOT NULL REFERENCES files(id),
  approved_by    UUID REFERENCES admin_users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE document_grants (
  document_id  UUID NOT NULL REFERENCES opportunity_documents(id) ON DELETE CASCADE,
  member_id    UUID NOT NULL REFERENCES members(id),
  granted_by   UUID NOT NULL REFERENCES admin_users(id),
  granted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ,
  PRIMARY KEY (document_id, member_id)
);

CREATE TABLE opportunity_interests (
  opportunity_id UUID NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  member_id      UUID NOT NULL REFERENCES members(id),
  note           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (opportunity_id, member_id)
);

CREATE TABLE introduction_requests (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_member_id UUID NOT NULL REFERENCES members(id),
  target_member_id    UUID NOT NULL REFERENCES members(id),
  opportunity_id      UUID REFERENCES opportunities(id),
  reason              TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'reviewing', 'target_asked', 'accepted', 'declined', 'introduced', 'cancelled')),
  target_consented_at TIMESTAMPTZ,                 -- nothing is shared before this is set
  handled_by          UUID REFERENCES admin_users(id),
  conversation_id     UUID REFERENCES conversations(id),
  source              TEXT NOT NULL DEFAULT 'member' CHECK (source IN ('member', 'qera', 'admin')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (requester_member_id <> target_member_id),
  CHECK (status <> 'introduced' OR target_consented_at IS NOT NULL)
);
CREATE INDEX introductions_queue_idx     ON introduction_requests (status, created_at);
CREATE INDEX introductions_requester_idx ON introduction_requests (requester_member_id);
CREATE INDEX introductions_target_idx    ON introduction_requests (target_member_id);

-- ---------------------------------------------------------------------
-- 9. Boutique
-- ---------------------------------------------------------------------
CREATE TABLE sellers (                              -- Quintara itself is the first seller
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT NOT NULL,
  partner_id     UUID REFERENCES partners(id),
  owner_user_id  UUID REFERENCES users(id),
  commission_bps INTEGER NOT NULL DEFAULT 0 CHECK (commission_bps BETWEEN 0 AND 10000),
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'suspended')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ
);

CREATE TABLE products (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id     UUID NOT NULL REFERENCES sellers(id),
  market_id     UUID NOT NULL REFERENCES markets(id),
  slug          TEXT NOT NULL,
  title         TEXT NOT NULL,
  category      TEXT NOT NULL,
  description   TEXT,
  members_only  BOOLEAN NOT NULL DEFAULT false,
  is_limited    BOOLEAN NOT NULL DEFAULT false,
  drop_at       TIMESTAMPTZ,                       -- limited drops open at this instant
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
  search_vector TSVECTOR,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);
CREATE UNIQUE INDEX products_slug_uq ON products (market_id, slug) WHERE deleted_at IS NULL;
CREATE INDEX products_browse_idx ON products (market_id, category) WHERE status = 'active';
CREATE INDEX products_search_idx ON products USING GIN (search_vector);

CREATE TABLE product_media (
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  file_id    UUID NOT NULL REFERENCES files(id),
  position   SMALLINT NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, file_id)
);

CREATE TABLE product_variants (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id    UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku           TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  options       JSONB NOT NULL DEFAULT '{}'::jsonb,       -- size, colour ...
  price_minor   BIGINT NOT NULL CHECK (price_minor >= 0),
  currency_code CHAR(3) NOT NULL REFERENCES currencies(code),
  stock_qty     INTEGER NOT NULL DEFAULT 0 CHECK (stock_qty >= 0),   -- can never oversell
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX product_variants_product_idx ON product_variants (product_id);

CREATE TYPE order_status AS ENUM ('pending_payment', 'paid', 'preparing', 'dispatched', 'delivered', 'cancelled', 'refunded');

CREATE TABLE orders (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number     TEXT NOT NULL UNIQUE,
  member_id        UUID NOT NULL REFERENCES members(id),
  market_id        UUID NOT NULL REFERENCES markets(id),
  status           order_status NOT NULL DEFAULT 'pending_payment',
  subtotal_minor   BIGINT NOT NULL CHECK (subtotal_minor >= 0),
  shipping_minor   BIGINT NOT NULL DEFAULT 0 CHECK (shipping_minor >= 0),
  tax_minor        BIGINT NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  total_minor      BIGINT NOT NULL CHECK (total_minor >= 0),
  currency_code    CHAR(3) NOT NULL REFERENCES currencies(code),
  shipping_address JSONB NOT NULL,
  carrier          TEXT,
  tracking_number  TEXT,
  dispatched_at    TIMESTAMPTZ,
  delivered_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (total_minor = subtotal_minor + shipping_minor + tax_minor)
);
CREATE INDEX orders_member_idx ON orders (member_id, created_at DESC);
CREATE INDEX orders_status_idx ON orders (market_id, status);

CREATE TABLE order_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  variant_id       UUID NOT NULL REFERENCES product_variants(id),
  seller_id        UUID NOT NULL REFERENCES sellers(id),
  title_snapshot   TEXT NOT NULL,                  -- what was bought, as it was named then
  quantity         INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_minor BIGINT NOT NULL CHECK (unit_price_minor >= 0),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX order_items_order_idx  ON order_items (order_id);
CREATE INDEX order_items_seller_idx ON order_items (seller_id);

-- ---------------------------------------------------------------------
-- 10. Payments and invoices (provider tokens only)
-- ---------------------------------------------------------------------
CREATE TABLE payment_methods (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL,                   -- paystack, peach, stripe ...
  provider_token  TEXT NOT NULL,                   -- never a card number
  brand           TEXT,
  last4           CHAR(4),
  expires_month   SMALLINT CHECK (expires_month BETWEEN 1 AND 12),
  expires_year    SMALLINT,
  is_default      BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ,
  UNIQUE (provider, provider_token)
);
CREATE UNIQUE INDEX payment_methods_default_uq ON payment_methods (user_id) WHERE is_default AND deleted_at IS NULL;

CREATE TYPE payment_status  AS ENUM ('pending', 'authorised', 'paid', 'failed', 'cancelled', 'partially_refunded', 'refunded');
CREATE TYPE payment_purpose AS ENUM ('membership', 'experience', 'boutique', 'concierge', 'deposit', 'partner_service');

CREATE TABLE payments (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES users(id),
  market_id             UUID NOT NULL REFERENCES markets(id),
  purpose               payment_purpose NOT NULL,
  membership_id         UUID REFERENCES memberships(id),
  booking_id            UUID REFERENCES experience_bookings(id),
  order_id              UUID REFERENCES orders(id),
  concierge_request_id  UUID REFERENCES concierge_requests(id),
  amount_minor          BIGINT NOT NULL CHECK (amount_minor > 0),
  refunded_minor        BIGINT NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0),
  currency_code         CHAR(3) NOT NULL REFERENCES currencies(code),
  status                payment_status NOT NULL DEFAULT 'pending',
  provider              TEXT NOT NULL,
  provider_payment_id   TEXT,
  payment_method_id     UUID REFERENCES payment_methods(id),
  idempotency_key       TEXT NOT NULL UNIQUE,      -- a retried request can never charge twice
  failure_reason        TEXT,
  paid_at               TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (refunded_minor <= amount_minor),
  CHECK (num_nonnulls(membership_id, booking_id, order_id, concierge_request_id) <= 1)
);
CREATE UNIQUE INDEX payments_provider_uq ON payments (provider, provider_payment_id) WHERE provider_payment_id IS NOT NULL;
CREATE INDEX payments_user_idx     ON payments (user_id, created_at DESC);
CREATE INDEX payments_status_idx   ON payments (market_id, status, created_at);
CREATE INDEX payments_booking_idx  ON payments (booking_id) WHERE booking_id IS NOT NULL;
CREATE INDEX payments_order_idx    ON payments (order_id)   WHERE order_id IS NOT NULL;

CREATE TABLE refunds (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id          UUID NOT NULL REFERENCES payments(id),
  amount_minor        BIGINT NOT NULL CHECK (amount_minor > 0),
  reason              TEXT,
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
  provider_refund_id  TEXT,
  requested_by        UUID REFERENCES admin_users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX refunds_payment_idx ON refunds (payment_id);

CREATE TABLE invoices (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number  TEXT NOT NULL UNIQUE,            -- sequential per legal entity
  user_id         UUID NOT NULL REFERENCES users(id),
  market_id       UUID NOT NULL REFERENCES markets(id),
  payment_id      UUID REFERENCES payments(id),
  kind            TEXT NOT NULL DEFAULT 'invoice' CHECK (kind IN ('invoice', 'receipt', 'credit_note')),
  status          TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('draft', 'issued', 'paid', 'void')),
  bill_to         JSONB NOT NULL,
  lines           JSONB NOT NULL,
  subtotal_minor  BIGINT NOT NULL,
  tax_minor       BIGINT NOT NULL DEFAULT 0,
  total_minor     BIGINT NOT NULL,
  currency_code   CHAR(3) NOT NULL REFERENCES currencies(code),
  pdf_file_id     UUID REFERENCES files(id),
  issued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX invoices_user_idx ON invoices (user_id, issued_at DESC);

-- ---------------------------------------------------------------------
-- 11. Quintara TV
-- ---------------------------------------------------------------------
CREATE TABLE series (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id     UUID REFERENCES markets(id),       -- NULL = shown everywhere
  title         TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  category      TEXT NOT NULL,
  description   TEXT,
  poster_file_id UUID REFERENCES files(id),
  members_only  BOOLEAN NOT NULL DEFAULT false,
  is_featured   BOOLEAN NOT NULL DEFAULT false,
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  search_vector TSVECTOR,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);
CREATE INDEX series_search_idx ON series USING GIN (search_vector);

CREATE TABLE videos (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id        UUID REFERENCES markets(id),
  title            TEXT NOT NULL,
  slug             TEXT NOT NULL UNIQUE,
  category         TEXT NOT NULL,
  description      TEXT,
  duration_seconds INTEGER CHECK (duration_seconds IS NULL OR duration_seconds > 0),
  provider         TEXT NOT NULL,                  -- streaming vendor
  provider_asset_id TEXT NOT NULL,
  poster_file_id   UUID REFERENCES files(id),
  members_only     BOOLEAN NOT NULL DEFAULT false,
  access_rules     JSONB NOT NULL DEFAULT '{}'::jsonb,       -- tiers / roles, when narrower than members_only
  experience_id    UUID REFERENCES experiences(id),
  is_featured      BOOLEAN NOT NULL DEFAULT false,
  status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'processing', 'published', 'archived')),
  published_at     TIMESTAMPTZ,
  search_vector    TSVECTOR,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ,
  UNIQUE (provider, provider_asset_id)
);
CREATE INDEX videos_browse_idx ON videos (category, published_at DESC) WHERE status = 'published' AND deleted_at IS NULL;
CREATE INDEX videos_search_idx ON videos USING GIN (search_vector);

CREATE TABLE episodes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  series_id      UUID NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  video_id       UUID NOT NULL UNIQUE REFERENCES videos(id),
  season_number  SMALLINT NOT NULL DEFAULT 1 CHECK (season_number >= 1),
  episode_number SMALLINT NOT NULL CHECK (episode_number >= 1),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (series_id, season_number, episode_number)
);

CREATE TABLE live_streams (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id          UUID REFERENCES markets(id),
  title              TEXT NOT NULL,
  description        TEXT,
  experience_id      UUID REFERENCES experiences(id),
  scheduled_start    TIMESTAMPTZ NOT NULL,
  started_at         TIMESTAMPTZ,
  ended_at           TIMESTAMPTZ,
  status             TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'live', 'ended', 'cancelled')),
  provider           TEXT NOT NULL,
  provider_stream_id TEXT NOT NULL,                -- ingest keys live in the secret manager, not here
  members_only       BOOLEAN NOT NULL DEFAULT true,
  recording_video_id UUID REFERENCES videos(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at         TIMESTAMPTZ
);
CREATE INDEX live_streams_schedule_idx ON live_streams (scheduled_start) WHERE status IN ('scheduled', 'live');

CREATE TABLE watch_progress (                      -- continue watching
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id         UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  position_seconds INTEGER NOT NULL DEFAULT 0 CHECK (position_seconds >= 0),
  completed        BOOLEAN NOT NULL DEFAULT false,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, video_id)
);
CREATE INDEX watch_progress_recent_idx ON watch_progress (user_id, updated_at DESC) WHERE NOT completed;

-- ---------------------------------------------------------------------
-- 12. Notifications, saved items, content
-- ---------------------------------------------------------------------
CREATE TYPE notification_category AS ENUM ('experience_invitation', 'booking_confirmation', 'waitlist_opening', 'message', 'concierge_update', 'qera_recommendation', 'membership_update', 'partner_privilege', 'order');
CREATE TYPE notification_channel  AS ENUM ('push', 'email', 'in_app', 'sms', 'whatsapp');

CREATE TABLE notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category    notification_category NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT,
  link        JSONB NOT NULL DEFAULT '{}'::jsonb,   -- {entity_type, entity_id}
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notifications_inbox_idx  ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;

CREATE TABLE notification_deliveries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id UUID NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  channel         notification_channel NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'delivered', 'failed', 'suppressed')),
  provider_message_id TEXT,
  sent_at         TIMESTAMPTZ,
  UNIQUE (notification_id, channel)
);

CREATE TABLE notification_preferences (
  user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category  notification_category NOT NULL,
  channel   notification_channel NOT NULL,
  enabled   BOOLEAN NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, category, channel)
);

CREATE TABLE device_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform    TEXT NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
  token       TEXT NOT NULL UNIQUE,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX device_tokens_user_idx ON device_tokens (user_id);

-- Polymorphic by design: item_id has no FK, the API validates type + access.
CREATE TABLE saved_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_type   TEXT NOT NULL CHECK (item_type IN ('experience', 'member', 'partner', 'product', 'video', 'series', 'opportunity')),
  item_id     UUID NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, item_type, item_id)
);
CREATE INDEX saved_items_user_idx ON saved_items (user_id, item_type, created_at DESC);

CREATE TABLE content_blocks (                       -- banners, featured items, announcements
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id   UUID REFERENCES markets(id),
  placement   TEXT NOT NULL,                        -- home_banner, home_featured, announcement ...
  audience_role_keys TEXT[] NOT NULL DEFAULT '{}',
  title       TEXT,
  body        TEXT,
  link        JSONB NOT NULL DEFAULT '{}'::jsonb,
  position    INTEGER NOT NULL DEFAULT 0,
  starts_at   TIMESTAMPTZ,
  ends_at     TIMESTAMPTZ,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_by  UUID REFERENCES admin_users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);
CREATE INDEX content_blocks_idx ON content_blocks (market_id, placement, position) WHERE is_active;

-- ---------------------------------------------------------------------
-- 13. QERA, audit, privacy, integrations
-- ---------------------------------------------------------------------
CREATE TABLE ai_conversations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  market_id   UUID REFERENCES markets(id),
  title       TEXT,
  channel     TEXT NOT NULL DEFAULT 'chat' CHECK (channel IN ('chat', 'voice', 'proactive')),
  language_code VARCHAR(10) REFERENCES languages(code),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);
CREATE INDEX ai_conversations_user_idx ON ai_conversations (user_id, updated_at DESC);

CREATE TABLE ai_messages (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  UUID NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  role             TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
  content          TEXT,
  tool_name        TEXT,                           -- search_experiences, request_introduction ...
  tool_input       JSONB,
  tool_result_ref  JSONB,                          -- ids returned, never copies of private data
  permission_checked TEXT,                         -- the permission key that allowed the call
  model            TEXT,
  input_tokens     INTEGER,
  output_tokens    INTEGER,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (role <> 'tool' OR tool_name IS NOT NULL)
);
CREATE INDEX ai_messages_thread_idx ON ai_messages (conversation_id, created_at);

-- Every transactional thing QERA wants to do is a row here first.
-- Nothing executes until confirmed_at is set by the member.
CREATE TABLE ai_actions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  UUID NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  message_id       UUID REFERENCES ai_messages(id),
  user_id          UUID NOT NULL REFERENCES users(id),
  tool_name        TEXT NOT NULL,
  arguments        JSONB NOT NULL,
  summary          TEXT NOT NULL,                  -- the sentence shown on the confirm button
  status           TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'confirmed', 'dismissed', 'executed', 'failed', 'expired')),
  confirmed_at     TIMESTAMPTZ,
  executed_at      TIMESTAMPTZ,
  result_entity_type TEXT,
  result_entity_id UUID,
  error            TEXT,
  expires_at       TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '30 minutes',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (status NOT IN ('executed') OR confirmed_at IS NOT NULL)
);
CREATE INDEX ai_actions_user_idx ON ai_actions (user_id, created_at DESC);

-- Append-only. The application role gets INSERT and SELECT only (see below).
CREATE TABLE audit_logs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_type   TEXT NOT NULL CHECK (actor_type IN ('member', 'admin', 'system', 'ai', 'partner')),
  actor_user_id UUID REFERENCES users(id),
  on_behalf_of_user_id UUID REFERENCES users(id),  -- set when QERA or staff act for a member
  action       TEXT NOT NULL,                      -- e.g. application.approved, payment.refunded, ai.action.executed
  entity_type  TEXT,
  entity_id    UUID,
  market_id    UUID REFERENCES markets(id),
  ip_address   INET,
  user_agent   TEXT,
  request_id   TEXT,
  changes      JSONB                               -- before / after, with sensitive fields redacted
);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id, occurred_at DESC);
CREATE INDEX audit_logs_actor_idx  ON audit_logs (actor_user_id, occurred_at DESC);
CREATE INDEX audit_logs_time_idx   ON audit_logs USING BRIN (occurred_at);

CREATE TABLE consents (                             -- POPIA: what was agreed to, and when
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose       TEXT NOT NULL,                      -- terms, privacy_policy, marketing_email, directory_listing, ai_personalisation ...
  document_version TEXT NOT NULL,
  granted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  withdrawn_at  TIMESTAMPTZ,
  ip_address    INET
);
CREATE INDEX consents_user_idx ON consents (user_id, purpose);

CREATE TABLE data_requests (                        -- export and account deletion
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id),
  kind          TEXT NOT NULL CHECK (kind IN ('export', 'deletion', 'correction')),
  status        TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'verifying', 'processing', 'completed', 'rejected')),
  export_file_id UUID REFERENCES files(id),
  handled_by    UUID REFERENCES admin_users(id),
  due_at        TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX data_requests_queue_idx ON data_requests (status, due_at);

-- Which vendor serves which capability in which market. Credentials are
-- referenced by name in the secret manager and never stored here.
CREATE TABLE integration_connections (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id    UUID REFERENCES markets(id),         -- NULL = global default
  capability   TEXT NOT NULL,                       -- payments, email, sms, whatsapp, maps, calendar, video, ai, crm, analytics, restaurant_booking, hotels, flights, rides ...
  provider     TEXT NOT NULL,
  secret_ref   TEXT NOT NULL,
  settings     JSONB NOT NULL DEFAULT '{}'::jsonb,
  priority     SMALLINT NOT NULL DEFAULT 0,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX integration_connections_uq ON integration_connections (capability, provider, COALESCE(market_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- Maps our rows to a vendor's ids, so a vendor can be swapped without touching core tables.
CREATE TABLE external_references (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type  TEXT NOT NULL,
  entity_id    UUID NOT NULL,
  provider     TEXT NOT NULL,
  external_id  TEXT NOT NULL,
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, entity_type, external_id)
);
CREATE INDEX external_references_entity_idx ON external_references (entity_type, entity_id);

CREATE TABLE webhook_events (                       -- inbound, de-duplicated, replayable
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider      TEXT NOT NULL,
  event_id      TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  payload       JSONB NOT NULL,
  signature_ok  BOOLEAN NOT NULL,
  processed_at  TIMESTAMPTZ,
  error         TEXT,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, event_id)
);
CREATE INDEX webhook_events_pending_idx ON webhook_events (received_at) WHERE processed_at IS NULL;

-- ---------------------------------------------------------------------
-- 14. updated_at trigger, audit immutability, row-level security
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DO $$
DECLARE t RECORD;
BEGIN
  FOR t IN
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = current_schema() AND column_name = 'updated_at'
  LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t.table_name || '_set_updated_at', t.table_name);
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- The API connects as a non-owner role and, per request, runs:
--   SET LOCAL app.user_id = '<uuid>';  SET LOCAL app.is_staff = 'true' | 'false';
-- Policies below are the pattern; the same shape applies to every member-data table.
CREATE OR REPLACE FUNCTION app_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;
CREATE OR REPLACE FUNCTION app_is_staff() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('app.is_staff', true), 'false') = 'true'
$$;

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY profiles_read ON profiles FOR SELECT USING (
  app_is_staff()
  OR user_id = app_user_id()
  OR (
    show_in_directory AND deleted_at IS NULL
    AND EXISTS (SELECT 1 FROM members me WHERE me.user_id = app_user_id() AND me.status = 'active')   -- only active members browse
    AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id = profiles.user_id AND b.blocked_id = app_user_id()) OR (b.blocker_id = app_user_id() AND b.blocked_id = profiles.user_id))
  )
);
CREATE POLICY profiles_write ON profiles FOR UPDATE USING (user_id = app_user_id() OR app_is_staff());

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY messages_participants ON messages FOR SELECT USING (
  EXISTS (SELECT 1 FROM conversation_participants p WHERE p.conversation_id = messages.conversation_id AND p.user_id = app_user_id() AND p.left_at IS NULL)
);   -- staff do not read private messages; reported messages are surfaced through reports
CREATE POLICY messages_send ON messages FOR INSERT WITH CHECK (
  sender_id = app_user_id()
  AND EXISTS (SELECT 1 FROM conversation_participants p WHERE p.conversation_id = messages.conversation_id AND p.user_id = app_user_id() AND p.left_at IS NULL)
);

ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY payments_owner ON payments FOR SELECT USING (user_id = app_user_id() OR app_is_staff());

ALTER TABLE member_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY member_notes_staff ON member_notes FOR ALL USING (app_is_staff());

ALTER TABLE ai_conversations ENABLE ROW LEVEL SECURITY;
CREATE POLICY ai_conversations_owner ON ai_conversations FOR ALL USING (user_id = app_user_id());

ALTER TABLE opportunity_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY opportunity_documents_granted ON opportunity_documents FOR SELECT USING (
  app_is_staff()
  OR EXISTS (
    SELECT 1 FROM document_grants g JOIN members m ON m.id = g.member_id
    WHERE g.document_id = opportunity_documents.id AND m.user_id = app_user_id() AND (g.expires_at IS NULL OR g.expires_at > now())
  )
);
-- Business: opportunities published by Quintara, and enquiries to the relationship manager.

-- An opportunity the Quintara team tells members about. Like a listing, it has no field for an amount,
-- a valuation or terms: a member who wants to pursue it asks the relationship manager.
CREATE TABLE business_updates (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id  UUID NOT NULL REFERENCES markets(id),
  title      TEXT NOT NULL CHECK (char_length(title) BETWEEN 4 AND 120),
  summary    TEXT NOT NULL CHECK (char_length(summary) BETWEEN 20 AND 2000),
  sector     TEXT NOT NULL DEFAULT '',
  -- Which roles may see it. Empty means every member.
  audience   TEXT[] NOT NULL DEFAULT '{}' CHECK (audience <@ ARRAY['founder', 'investor', 'creative', 'executive']),
  status     TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX business_updates_status_idx ON business_updates (status, created_at DESC);

-- A private conversation between one member and the relationship manager (staff who hold admin.business.manage).
CREATE TABLE rm_enquiries (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id  UUID NOT NULL REFERENCES markets(id),
  member_id  UUID NOT NULL REFERENCES members(id),
  topic      TEXT NOT NULL CHECK (topic IN ('investment_insight', 'business_dealing', 'opportunity')),
  subject    TEXT NOT NULL CHECK (char_length(subject) BETWEEN 4 AND 120),
  update_id  UUID REFERENCES business_updates(id) ON DELETE SET NULL,
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX rm_enquiries_member_idx ON rm_enquiries (member_id, created_at DESC);
CREATE INDEX rm_enquiries_status_idx ON rm_enquiries (status, updated_at);

CREATE TABLE rm_messages (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enquiry_id     UUID NOT NULL REFERENCES rm_enquiries(id) ON DELETE CASCADE,
  sender_user_id UUID REFERENCES users(id),
  from_manager   BOOLEAN NOT NULL,
  body           TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX rm_messages_enquiry_idx ON rm_messages (enquiry_id, created_at);
-- Lifestyle services and their booking requests, a fuller partner directory, member profile pictures,
-- the home page slides, and the relationship manager's subjects.

-- Partner directory: what the partner offers and who to speak to there. These are the partner's business
-- details, entered by staff, and are shown to members only.
ALTER TABLE partners
  ADD COLUMN offer         TEXT NOT NULL DEFAULT '',
  ADD COLUMN contact_name  TEXT NOT NULL DEFAULT '',
  ADD COLUMN contact_email TEXT NOT NULL DEFAULT '',
  ADD COLUMN contact_phone TEXT NOT NULL DEFAULT '',
  ADD COLUMN address       TEXT NOT NULL DEFAULT '';

-- A member's profile picture.
ALTER TABLE profiles ADD COLUMN avatar_media_id UUID REFERENCES media(id);

-- Services that guests and members can ask to book. The concierge desk arranges each request.
CREATE TABLE lifestyle_services (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id   UUID NOT NULL REFERENCES markets(id),
  name        TEXT NOT NULL CHECK (char_length(name) BETWEEN 2 AND 120),
  description TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 1000),
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (market_id, name)
);

CREATE TABLE service_requests (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id      UUID NOT NULL REFERENCES markets(id),
  service_id     UUID NOT NULL REFERENCES lifestyle_services(id),
  member_id      UUID REFERENCES members(id),   -- NULL for a guest
  contact_name   TEXT NOT NULL CHECK (char_length(contact_name) BETWEEN 2 AND 120),
  contact_email  TEXT NOT NULL CHECK (char_length(contact_email) BETWEEN 3 AND 200),
  preferred_date DATE,
  notes          TEXT NOT NULL DEFAULT '' CHECK (char_length(notes) <= 1000),
  status         TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'in_progress', 'confirmed', 'completed', 'cancelled')),
  handled_by     UUID REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX service_requests_status_idx ON service_requests (status, created_at);
CREATE INDEX service_requests_member_idx ON service_requests (member_id);

-- The welcome area of the home page alternates between these. A photograph is stored with the other
-- images; a film is a link to where it is hosted, as for Quintara TV.
CREATE TABLE home_slides (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id  UUID NOT NULL REFERENCES markets(id),
  kind       TEXT NOT NULL CHECK (kind IN ('image', 'video')),
  media_id   UUID REFERENCES media(id),
  video_url  TEXT,
  caption    TEXT NOT NULL DEFAULT '' CHECK (char_length(caption) <= 160),
  position   INTEGER NOT NULL DEFAULT 0,
  is_active  BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((kind = 'image' AND media_id IS NOT NULL AND video_url IS NULL) OR (kind = 'video' AND video_url IS NOT NULL AND media_id IS NULL))
);

-- The relationship manager facilitates partnerships, advisory and brand collaborations.
ALTER TABLE rm_enquiries DROP CONSTRAINT rm_enquiries_topic_check;
UPDATE rm_enquiries SET topic = 'partnership' WHERE topic = 'business_dealing';
ALTER TABLE rm_enquiries ADD CONSTRAINT rm_enquiries_topic_check CHECK (topic IN ('partnership', 'advisory', 'brand_collaboration', 'investment_insight', 'opportunity'));
-- QÉRA: bookings it makes with partners on a member's behalf, and the documents it prepares.

-- A booking request sent to a partner at the member's instruction. The partner answers through a private link;
-- only a hash of the link's token is kept. The partner is given the member's name, the date, the time, the
-- number of guests and the note, and nothing else.
CREATE TABLE partner_bookings (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id      UUID NOT NULL REFERENCES markets(id),
  partner_id     UUID NOT NULL REFERENCES partners(id),
  member_id      UUID NOT NULL REFERENCES members(id),
  booking_date   DATE NOT NULL,
  booking_time   TEXT CHECK (booking_time IS NULL OR booking_time ~ '^[0-2][0-9]:[0-5][0-9]$'),
  party_size     INTEGER NOT NULL CHECK (party_size BETWEEN 1 AND 50),
  notes          TEXT NOT NULL DEFAULT '' CHECK (char_length(notes) <= 1000),
  status         TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'confirmed', 'declined', 'cancelled')),
  token_hash     TEXT NOT NULL UNIQUE,
  partner_note   TEXT NOT NULL DEFAULT '' CHECK (char_length(partner_note) <= 500),
  emailed_at     TIMESTAMPTZ,
  email_attempts INTEGER NOT NULL DEFAULT 0,
  responded_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX partner_bookings_member_idx ON partner_bookings (member_id, created_at DESC);
CREATE INDEX partner_bookings_unsent_idx ON partner_bookings (created_at) WHERE emailed_at IS NULL AND status = 'requested';

-- An itinerary or plan QÉRA has prepared for a member. Private to that member.
CREATE TABLE qera_documents (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('day', 'weekend', 'holiday')),
  title      TEXT NOT NULL,
  content    JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX qera_documents_user_idx ON qera_documents (user_id, created_at DESC);
-- Lifestyle services are classified like partners, so both read as one directory.
ALTER TABLE lifestyle_services ADD COLUMN category TEXT NOT NULL DEFAULT 'Lifestyle' CHECK (char_length(category) BETWEEN 2 AND 60);
UPDATE lifestyle_services SET category = 'Photography and Media' WHERE name = 'Suné Photography';
UPDATE lifestyle_services SET category = 'Mobility' WHERE name = 'One&Only Yacht Charter';
UPDATE lifestyle_services SET category = 'Home and Design' WHERE name = 'Vellora Interiors';
UPDATE lifestyle_services SET category = 'Mobility' WHERE name = 'Elite Motion';
UPDATE lifestyle_services SET category = 'Beauty and Style' WHERE name = 'Atelier Lunda';
UPDATE lifestyle_services SET category = 'Wellness' WHERE name = 'Apex Performance';
UPDATE lifestyle_services SET category = 'Dining' WHERE name = 'The Culinary House';
UPDATE lifestyle_services SET category = 'Beauty and Style' WHERE name = 'Éclat Atelier';
UPDATE lifestyle_services SET category = 'Wellness' WHERE name = 'Skye Health';
UPDATE lifestyle_services SET category = 'Talent and Brand' WHERE name = 'Alpha Management';
UPDATE lifestyle_services SET category = 'Talent and Brand' WHERE name = 'EliteReach Management';
UPDATE lifestyle_services SET category = 'Business' WHERE name = 'BMM Capital';
UPDATE lifestyle_services SET category = 'Photography and Media' WHERE name = 'TheFeed';
UPDATE lifestyle_services SET category = 'Photography and Media' WHERE name = 'Nava Studios';
UPDATE lifestyle_services SET category = 'Wellness' WHERE name = 'Novaderm Aesthetics';
UPDATE lifestyle_services SET category = 'Wellness' WHERE name = 'Wonderland Cape Town';
UPDATE lifestyle_services SET category = 'Wellness' WHERE name = 'Virgin Active Country Club';
CREATE INDEX lifestyle_services_category_idx ON lifestyle_services (category, position);

-- 0019_guest_accounts.sql
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

-- 0020_service_descriptions.sql
-- Fuller descriptions for the lifestyle services. A description staff have already changed is left as it is.
UPDATE lifestyle_services SET description = 'Professional photography for portraits, events and brands, with editing and retouching of every image. Suné Photography also creates user-generated content for social media that looks natural and personal. Tell us the occasion and the look you want, and the session is arranged for you.', updated_at = now() WHERE name = 'Suné Photography' AND description = 'Professional photography and editing, and user-generated content.';
UPDATE lifestyle_services SET description = 'Private yacht charters for sunset cruises, celebrations and full days at sea. Each charter is arranged around your party: the vessel, the crew, the timing and the catering. Tell us the date, the number of guests and the occasion.', updated_at = now() WHERE name = 'One&Only Yacht Charter' AND description = 'Private yacht rentals.';
UPDATE lifestyle_services SET description = 'An interior design practice for homes, apartments and workspaces. From a single room to a full renovation, Vellora works through the concept, materials, furniture and finishing touches, and sees the project through to the finished space.', updated_at = now() WHERE name = 'Vellora Interiors' AND description = 'Interior design company.';
UPDATE lifestyle_services SET description = 'Luxury and performance cars to rent for a day, a weekend, a special occasion or a longer visit. Delivery and collection can be arranged on request. Tell us the dates and the kind of car you have in mind.', updated_at = now() WHERE name = 'Elite Motion' AND description = 'Luxury car rentals.';
UPDATE lifestyle_services SET description = 'Personal branding and styling for how you present yourself, in person and online. Atelier Lunda advises on wardrobe, image and personal brand, for everyday wear, public appearances and the moments that matter.', updated_at = now() WHERE name = 'Atelier Lunda' AND description = 'Personal branding and styling.';
UPDATE lifestyle_services SET description = 'A personal trainer, nutritionist and coach in one programme. Sessions are planned around your goals, whether strength, fitness, body composition or recovery, with nutrition guidance and ongoing coaching to keep you on track.', updated_at = now() WHERE name = 'Apex Performance' AND description = 'Personal trainer, nutritionist and coach.';
UPDATE lifestyle_services SET description = 'A private chef for your home or your event. Menus are designed with you around the occasion, your guests and any dietary needs, from an intimate dinner for two to a larger celebration, and cooked on the day where you are hosting.', updated_at = now() WHERE name = 'The Culinary House' AND description = 'Private chef.';
UPDATE lifestyle_services SET description = 'Beauty and make-up by professional artists for events, shoots, weddings and evenings out. Tell us the occasion, the look you would like and where you will be getting ready, and an appointment is arranged.', updated_at = now() WHERE name = 'Éclat Atelier' AND description = 'Beauty and make-up.';
UPDATE lifestyle_services SET description = 'IV drip therapy for hydration, recovery and wellbeing, given by qualified health professionals. Each appointment starts with a short consultation so that the drip suits you, and it is not given where it would not be safe.', updated_at = now() WHERE name = 'Skye Health' AND description = 'IV drips.';
UPDATE lifestyle_services SET description = 'A modelling agency representing talent for fashion, commercial and editorial work. Brands can book models for campaigns, shoots and events, and aspiring models can ask about representation.', updated_at = now() WHERE name = 'Alpha Management' AND description = 'Modelling agency.';
UPDATE lifestyle_services SET description = 'An elite agency for brand partnerships, marketing, promotions and user-generated content. EliteReach matches brands with the right creators and talent, and plans and runs campaigns from the first idea to the results.', updated_at = now() WHERE name = 'EliteReach Management' AND description = 'Elite agency for brand partnerships, marketing, promotions and user-generated content.';
UPDATE lifestyle_services SET description = 'Financial services, business advisory and investments. BMM Capital works with founders and businesses on strategy, structuring and funding. Any financial or investment advice comes from BMM Capital directly, not from Quintara. Mr. Wayne Huffton, Quintara''s relationship manager, is with BMM Capital.', updated_at = now() WHERE name = 'BMM Capital' AND description = 'Financial services, business advisory and investments.';
UPDATE lifestyle_services SET description = 'News, promotions and adverts. TheFeed publishes stories and features, and places promotions and adverts for brands and businesses that want to reach its audience.', updated_at = now() WHERE name = 'TheFeed' AND description = 'News, promotions and adverts.';
UPDATE lifestyle_services SET description = 'Photography and videography studios, with full production. Hire a studio for your own shoot, or have Nava Studios produce the whole project, from planning and crew to filming and editing.', updated_at = now() WHERE name = 'Nava Studios' AND description = 'Photography and videography studios, and production.';
UPDATE lifestyle_services SET description = 'Skin, body and wellness treatments from an aesthetics clinic. Every treatment starts with a consultation, and what is recommended is chosen for your skin and your goals.', updated_at = now() WHERE name = 'Novaderm Aesthetics' AND description = 'Skin, body and wellness.';
UPDATE lifestyle_services SET description = 'Wellness, a hotel, a sauna and co-working under one roof. Book a stay, a sauna session or a day at a desk, or combine them for a day that mixes work and rest.', updated_at = now() WHERE name = 'Wonderland Cape Town' AND description = 'Wellness, hotel, sauna and co-working.';
UPDATE lifestyle_services SET description = 'A country club with a gym and wellness facilities. Quintara can arrange a visit, classes or sessions for you; facilities, access and membership terms are set by the club.', updated_at = now() WHERE name = 'Virgin Active Country Club' AND description = 'Wellness and gym.';

-- 0021_chief_of_staff.sql
-- QÉRA as Chief of Staff: service packages, the member's memory, reminders, the weekly brief, and booking a whole plan.

-- Packages: what each lifestyle service offers, at what indicative price and with how much notice.
CREATE TABLE service_packages (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id       UUID NOT NULL REFERENCES lifestyle_services(id) ON DELETE CASCADE,
  name             TEXT NOT NULL CHECK (char_length(name) BETWEEN 2 AND 120),
  description      TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 600),
  price_minor      INTEGER CHECK (price_minor IS NULL OR price_minor >= 0),   -- NULL: price on request
  price_basis      TEXT NOT NULL DEFAULT 'per_booking' CHECK (price_basis IN ('per_person', 'per_session', 'per_booking', 'per_hour', 'per_day')),
  currency_code    CHAR(3) NOT NULL DEFAULT 'ZAR' REFERENCES currencies(code),
  lead_time_hours  INTEGER NOT NULL DEFAULT 48 CHECK (lead_time_hours BETWEEN 0 AND 8760),
  duration         TEXT NOT NULL DEFAULT '' CHECK (char_length(duration) <= 60),
  position         INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'published', 'archived')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX service_packages_service_idx ON service_packages (service_id, position);
-- A request keeps the package and the price as they were when it was made.
ALTER TABLE service_requests ADD COLUMN package_id UUID REFERENCES service_packages(id) ON DELETE SET NULL;
ALTER TABLE service_requests ADD COLUMN package_name TEXT;
ALTER TABLE service_requests ADD COLUMN price_label TEXT;

-- What QÉRA remembers about a member. Written only by the member, or by QÉRA after the member has confirmed.
CREATE TABLE qera_memory (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('dietary', 'likes', 'favourite', 'date', 'person', 'note')),
  label       TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 120),
  detail      TEXT NOT NULL DEFAULT '' CHECK (char_length(detail) <= 300),
  on_date     DATE,                                   -- for important dates
  source      TEXT NOT NULL DEFAULT 'member' CHECK (source IN ('member', 'qera')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX qera_memory_user_idx ON qera_memory (user_id, kind);

-- Reminders the member or QÉRA set, delivered as notifications.
CREATE TABLE qera_reminders (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text        TEXT NOT NULL CHECK (char_length(text) BETWEEN 2 AND 200),
  remind_at   TIMESTAMPTZ NOT NULL,
  status      TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'sent', 'cancelled')),
  source      TEXT NOT NULL DEFAULT 'member' CHECK (source IN ('member', 'qera')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at     TIMESTAMPTZ
);
CREATE INDEX qera_reminders_due_idx ON qera_reminders (remind_at) WHERE status = 'scheduled';

-- Things QÉRA tells a member of its own accord (the weekly brief, a date coming up, tomorrow's booking), each once.
CREATE TABLE qera_nudges (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nudge_key   TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, nudge_key)
);

-- The weekly brief can be switched off. NULL means the default, which is on.
ALTER TABLE privacy_settings ADD COLUMN weekly_brief BOOLEAN;

-- Booking a whole plan: what happened to each line, keyed by its position in the plan.
ALTER TABLE qera_documents ADD COLUMN booked JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Packages for the services already in place (a new database gets them from the seed instead).
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Portrait session', 'Portraits at a location of your choice, with a selection of edited images.', 350000, 'per_session', 72, '2 hours', 0 FROM lifestyle_services WHERE name = 'Suné Photography';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Event coverage', 'Photography of your event, edited and delivered as a private gallery.', 1200000, 'per_booking', 168, 'Up to 4 hours', 1 FROM lifestyle_services WHERE name = 'Suné Photography';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Content day', 'A day creating natural, personal content for social media.', 650000, 'per_day', 120, 'Full day', 2 FROM lifestyle_services WHERE name = 'Suné Photography';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Sunset cruise', 'A private yacht with crew for a sunset cruise.', 2500000, 'per_booking', 72, '3 hours', 0 FROM lifestyle_services WHERE name = 'One&Only Yacht Charter';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Full-day charter', 'A private yacht for the day, with crew and catering arranged around your party.', NULL, 'per_day', 168, 'Full day', 1 FROM lifestyle_services WHERE name = 'One&Only Yacht Charter';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Design consultation', 'A first visit to understand the space, how you live in it and what you would like.', 250000, 'per_session', 120, '90 minutes', 0 FROM lifestyle_services WHERE name = 'Vellora Interiors';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Room design', 'Concept, materials, furniture and finishing touches for one room.', NULL, 'per_booking', 336, '', 1 FROM lifestyle_services WHERE name = 'Vellora Interiors';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'A day with a luxury car', 'A luxury or performance car for the day.', 450000, 'per_day', 48, '24 hours', 0 FROM lifestyle_services WHERE name = 'Elite Motion';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Weekend', 'A luxury car from Friday to Sunday.', 1100000, 'per_booking', 72, 'Friday to Sunday', 1 FROM lifestyle_services WHERE name = 'Elite Motion';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Style consultation', 'Your wardrobe, image and personal brand, with clear recommendations.', 280000, 'per_session', 72, '2 hours', 0 FROM lifestyle_services WHERE name = 'Atelier Lunda';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Wardrobe edit', 'An edit of your wardrobe at home, with a list of what to keep, change and add.', 600000, 'per_session', 168, 'Half a day', 1 FROM lifestyle_services WHERE name = 'Atelier Lunda';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Personal training session', 'One session with a personal trainer.', 75000, 'per_session', 24, '1 hour', 0 FROM lifestyle_services WHERE name = 'Apex Performance';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Four-week programme', 'Training, nutrition guidance and coaching for four weeks.', 750000, 'per_booking', 72, '4 weeks', 1 FROM lifestyle_services WHERE name = 'Apex Performance';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Dinner for two', 'A private chef cooks a dinner for two where you are hosting.', 480000, 'per_booking', 120, 'Evening', 0 FROM lifestyle_services WHERE name = 'The Culinary House';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Tasting menu', 'A tasting menu cooked for your guests, designed with you.', 220000, 'per_person', 120, 'Evening', 1 FROM lifestyle_services WHERE name = 'The Culinary House';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Celebration', 'A menu for a larger celebration, up to twenty guests.', NULL, 'per_booking', 336, '', 2 FROM lifestyle_services WHERE name = 'The Culinary House';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Event make-up', 'Make-up for an event or evening out, where you are getting ready.', 150000, 'per_person', 48, '1 hour', 0 FROM lifestyle_services WHERE name = 'Éclat Atelier';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Bridal', 'Bridal make-up with a trial beforehand.', NULL, 'per_booking', 336, '', 1 FROM lifestyle_services WHERE name = 'Éclat Atelier';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Hydration drip', 'An IV drip for hydration, after a short consultation.', 180000, 'per_session', 24, '45 minutes', 0 FROM lifestyle_services WHERE name = 'Skye Health';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Recovery drip', 'An IV drip for recovery, after a short consultation.', 240000, 'per_session', 24, '60 minutes', 1 FROM lifestyle_services WHERE name = 'Skye Health';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Model booking', 'Models for a campaign, shoot or event.', NULL, 'per_day', 168, '', 0 FROM lifestyle_services WHERE name = 'Alpha Management';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Brand partnership consultation', 'A first meeting about your brand, your audience and the partnerships that would suit it.', 300000, 'per_session', 120, '1 hour', 0 FROM lifestyle_services WHERE name = 'EliteReach Management';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Creator campaign', 'A campaign with matched creators, planned and run from idea to results.', NULL, 'per_booking', 336, '', 1 FROM lifestyle_services WHERE name = 'EliteReach Management';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Introductory meeting', 'A first meeting with BMM Capital about your business or what you are looking for.', NULL, 'per_session', 72, '1 hour', 0 FROM lifestyle_services WHERE name = 'BMM Capital';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Promotion feature', 'A feature or advert placed with TheFeed''s audience.', NULL, 'per_booking', 168, '', 0 FROM lifestyle_services WHERE name = 'TheFeed';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Studio hire', 'A photography or videography studio for your own shoot.', 120000, 'per_hour', 48, 'Per hour', 0 FROM lifestyle_services WHERE name = 'Nava Studios';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Full production', 'Planning, crew, filming and editing for your project.', NULL, 'per_booking', 336, '', 1 FROM lifestyle_services WHERE name = 'Nava Studios';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Skin consultation', 'A consultation to recommend treatments for your skin and your goals.', 90000, 'per_session', 48, '45 minutes', 0 FROM lifestyle_services WHERE name = 'Novaderm Aesthetics';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Signature facial', 'A facial chosen for your skin.', 220000, 'per_session', 72, '75 minutes', 1 FROM lifestyle_services WHERE name = 'Novaderm Aesthetics';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Sauna session', 'A sauna session.', 45000, 'per_person', 4, '90 minutes', 0 FROM lifestyle_services WHERE name = 'Wonderland Cape Town';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Work and wellness day', 'A day at a desk with sauna access.', 65000, 'per_day', 24, 'Full day', 1 FROM lifestyle_services WHERE name = 'Wonderland Cape Town';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Overnight stay', 'A night at Wonderland.', NULL, 'per_booking', 48, 'One night', 2 FROM lifestyle_services WHERE name = 'Wonderland Cape Town';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Day visit', 'A visit to the club''s gym and wellness facilities, on the club''s terms.', NULL, 'per_person', 24, 'Day', 0 FROM lifestyle_services WHERE name = 'Virgin Active Country Club';

-- 0022_cities_calendar_daily_brief.sql
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

-- 0023_section_copy.sql
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

-- 0024_more_sections.sql
-- More sections whose descriptions staff can edit from the admin console: Experiences, Business, the relationship
-- manager, People to meet, Lifestyle services, the partner directory, Quintara TV, the membership application,
-- the guest account and Notifications. Until a section is written here, the apps show Quintara's default wording.
ALTER TABLE section_copy DROP CONSTRAINT IF EXISTS section_copy_key_check;
ALTER TABLE section_copy ADD CONSTRAINT section_copy_key_check CHECK (key IN (
  'qera', 'club', 'concierge', 'lifestyle', 'privileges', 'boutique', 'bookings', 'messaging', 'curator',
  'experiences', 'business', 'relationship', 'matching', 'services', 'partners', 'tv', 'membership', 'guest', 'notifications'));

-- 0025_application_plans_questions.sql
-- The membership application: the plan an applicant applies for, the phone number (kept in the application data,
-- seen only by staff), and questions staff can reword or add.

-- Plans are membership tiers with a residency and a fixed term, paid once.
ALTER TABLE membership_tiers
  ADD COLUMN residency   TEXT CHECK (residency IN ('resident', 'international')),
  ADD COLUMN term_months INT CHECK (term_months BETWEEN 1 AND 60);

-- Markets priced in rand start with the standard plans. Other markets add their own under Tiers.
INSERT INTO membership_tiers (market_id, name, price_minor, currency_code, billing_period, residency, term_months)
SELECT m.id, p.name, p.price_minor, m.currency_code, 'once', p.residency, p.term_months
  FROM markets m CROSS JOIN (VALUES
    ('Resident, 3 months', 1000000, 'resident', 3), ('Resident, 6 months', 1800000, 'resident', 6), ('Resident, 12 months', 3000000, 'resident', 12),
    ('International, 1 month', 800000, 'international', 1), ('International, 3 months', 1600000, 'international', 3),
    ('International, 6 months', 2800000, 'international', 6), ('International, 12 months', 5000000, 'international', 12)
  ) AS p(name, price_minor, residency, term_months)
 WHERE m.currency_code = 'ZAR'
ON CONFLICT (market_id, name) DO NOTHING;

-- What the applicant asked for. Staff offer a tier on approval, normally this one.
ALTER TABLE membership_applications ADD COLUMN requested_tier_id UUID REFERENCES membership_tiers(id);

-- Staff wording for the built-in questions. A question with no row uses the default wording.
CREATE TABLE application_question_copy (
  id         UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  key        TEXT PRIMARY KEY CHECK (key IN ('email', 'fullName', 'phone', 'city', 'position', 'company', 'industry', 'roles', 'interests', 'motivation', 'referral', 'social', 'links', 'membership')),
  label      TEXT NOT NULL CHECK (char_length(label) BETWEEN 2 AND 160),
  help       TEXT NOT NULL DEFAULT '' CHECK (char_length(help) <= 300),
  options    JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Questions staff add. They are retired rather than deleted, so earlier answers keep their question.
CREATE TABLE application_questions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       TEXT NOT NULL CHECK (kind IN ('short_text', 'long_text', 'choice', 'multi_choice', 'yes_no')),
  label      TEXT NOT NULL CHECK (char_length(label) BETWEEN 2 AND 160),
  help       TEXT NOT NULL DEFAULT '' CHECK (char_length(help) <= 300),
  options    JSONB NOT NULL DEFAULT '[]'::jsonb,
  required   BOOLEAN NOT NULL DEFAULT false,
  is_active  BOOLEAN NOT NULL DEFAULT true,
  position   INT NOT NULL DEFAULT 100,
  created_by UUID REFERENCES users(id),
  updated_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 0026_whatsapp.sql
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

-- 0027_sign_in_codes.sql
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

-- 0028_order_tracking_and_photographs.sql
-- Maison Quintara order tracking, and high-resolution photographs.

-- Every step of an order, when it happened and who recorded it: placed, paid, processing, dispatched for delivery,
-- received, and also cancellations, refunds and staff notes. The buyer sees the steps; staff notes stay internal.
CREATE TABLE order_events (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id   UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('placed', 'paid', 'preparing', 'dispatched', 'delivered', 'cancelled', 'refunded', 'note')),
  note       TEXT NOT NULL DEFAULT '' CHECK (char_length(note) <= 1000),
  actor_id   UUID REFERENCES users(id),          -- the buyer, a member of staff, or NULL when Quintara did it itself
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX order_events_order_idx ON order_events (order_id, created_at);

-- Who took the parcel in, recorded when the order is marked received.
ALTER TABLE orders ADD COLUMN received_by TEXT CHECK (received_by IS NULL OR char_length(received_by) <= 120);

-- Orders placed before this change: their placing, their payment, and the step they are at now.
INSERT INTO order_events (order_id, kind, actor_id, created_at) SELECT id, 'placed', user_id, created_at FROM orders;
INSERT INTO order_events (order_id, kind, actor_id, created_at)
  SELECT o.id, 'paid', o.user_id, COALESCE((SELECT min(p.paid_at) FROM payments p WHERE p.order_id = o.id), o.updated_at)
    FROM orders o WHERE o.status IN ('paid', 'preparing', 'dispatched', 'delivered')
       OR (o.status = 'cancelled' AND EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.paid_at IS NOT NULL));
INSERT INTO order_events (order_id, kind, created_at) SELECT id, status, updated_at FROM orders WHERE status IN ('preparing', 'dispatched', 'delivered', 'cancelled');

-- Photographs: the stored master's size, and the smaller copies made for screens of different widths.
ALTER TABLE media ADD COLUMN width INT CHECK (width IS NULL OR width > 0), ADD COLUMN height INT CHECK (height IS NULL OR height > 0);
CREATE TABLE media_variants (
  media_id     UUID NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  width        INT NOT NULL CHECK (width > 0),
  height       INT NOT NULL CHECK (height > 0),
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  byte_size    INT NOT NULL CHECK (byte_size > 0),
  data_base64  TEXT NOT NULL,
  PRIMARY KEY (media_id, content_type, width)
);

-- 0029_two_factor_and_session_security.sql
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

-- 0030_staff_accounts_and_audit_log.sql
-- Admin console accounts (up to five active), and an audit log that cannot be changed or quietly cut short.

-- Who works in the admin console. A person's staff powers come from their role (user_roles: admin or concierge),
-- and count only while this account is active.
CREATE TABLE staff_accounts (
  user_id        UUID PRIMARY KEY REFERENCES users(id),
  full_name      TEXT NOT NULL CHECK (char_length(full_name) BETWEEN 2 AND 120),
  title          TEXT NOT NULL DEFAULT '' CHECK (char_length(title) <= 80),
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_by     UUID REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_sign_in_at TIMESTAMPTZ
);
-- Staff who existed before this change.
INSERT INTO staff_accounts (user_id, full_name)
  SELECT DISTINCT u.id, COALESCE(NULLIF(p.full_name, ''), split_part(u.email, '@', 1), 'Staff')
    FROM user_roles r JOIN users u ON u.id = r.user_id LEFT JOIN profiles p ON p.user_id = u.id
   WHERE r.role_key IN ('admin', 'concierge') AND u.deleted_at IS NULL
  ON CONFLICT DO NOTHING;

-- Every request a member of staff makes to the admin console: what was opened or changed, when, from where, and
-- the answer. Query values are never kept (they can carry personal details); the route pattern and its id are.
CREATE TABLE staff_activity (
  seq          BIGSERIAL PRIMARY KEY,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id      UUID NOT NULL REFERENCES users(id),
  method       TEXT NOT NULL,
  route        TEXT NOT NULL,
  target_id    TEXT,
  status       INT NOT NULL,
  ip           TEXT,
  user_agent   TEXT,
  prev_hash    TEXT NOT NULL DEFAULT '',
  hash         TEXT NOT NULL DEFAULT ''
);
CREATE INDEX staff_activity_user_idx ON staff_activity (user_id, occurred_at DESC);

-- The audit log gains where an action came from, an order, and a hash chain: each entry carries the hash of the one
-- before, so removing or editing any entry breaks every hash after it, and the console's check says where.
ALTER TABLE audit_logs ADD COLUMN ip TEXT, ADD COLUMN user_agent TEXT, ADD COLUMN seq BIGSERIAL, ADD COLUMN prev_hash TEXT NOT NULL DEFAULT '', ADD COLUMN hash TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX audit_logs_seq_idx ON audit_logs (seq);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_user_id, occurred_at DESC);

-- What is hashed for an entry. The time is taken as milliseconds since 1970, so the database's time zone setting
-- can never change it.
CREATE FUNCTION audit_payload(t TEXT, r JSONB, at TIMESTAMPTZ) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN t = 'audit_logs'
    THEN concat_ws('|', r->>'seq', (extract(epoch FROM at) * 1000)::bigint::text, r->>'actor_user_id', r->>'action', r->>'entity_type', r->>'entity_id', r->>'changes', r->>'ip', r->>'user_agent')
    ELSE concat_ws('|', r->>'seq', (extract(epoch FROM at) * 1000)::bigint::text, r->>'user_id', r->>'method', r->>'route', r->>'target_id', r->>'status', r->>'ip', r->>'user_agent') END
$$;

-- Chains each new entry to the last one. One entry at a time per table, so the chain has no forks.
CREATE FUNCTION audit_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE last TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(TG_TABLE_NAME));
  NEW.occurred_at := date_trunc('milliseconds', COALESCE(NEW.occurred_at, now()));
  EXECUTE format('SELECT hash FROM %I ORDER BY seq DESC LIMIT 1', TG_TABLE_NAME) INTO last;
  NEW.prev_hash := COALESCE(last, '');
  NEW.hash := encode(sha256(convert_to(NEW.prev_hash || '|' || audit_payload(TG_TABLE_NAME, to_jsonb(NEW), NEW.occurred_at), 'UTF8')), 'hex');
  RETURN NEW;
END $$;

-- Nothing in the log can be changed or removed, by the apps or by anyone with ordinary database access.
CREATE FUNCTION audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: nothing in it can be changed or deleted', TG_TABLE_NAME;
END $$;

-- Entries made before this change are chained once, in order. The append-only rule (from the first migration) is
-- lifted for this one statement and put back at once below.
DROP TRIGGER audit_logs_append_only ON audit_logs;
DO $$
DECLARE r RECORD; last TEXT := '';
BEGIN
  FOR r IN SELECT * FROM audit_logs ORDER BY occurred_at, seq LOOP
    UPDATE audit_logs SET occurred_at = date_trunc('milliseconds', r.occurred_at) WHERE id = r.id;
    UPDATE audit_logs a SET prev_hash = last,
      hash = encode(sha256(convert_to(last || '|' || audit_payload('audit_logs', to_jsonb(a), a.occurred_at), 'UTF8')), 'hex')
      WHERE a.id = r.id RETURNING a.hash INTO last;
  END LOOP;
END $$;

CREATE TRIGGER audit_logs_chain BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION audit_chain();
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION audit_append_only();
CREATE TRIGGER staff_activity_chain BEFORE INSERT ON staff_activity FOR EACH ROW EXECUTE FUNCTION audit_chain();
CREATE TRIGGER staff_activity_append_only BEFORE UPDATE OR DELETE ON staff_activity FOR EACH ROW EXECUTE FUNCTION audit_append_only();

-- 0031_services_in_the_directory.sql
-- Lifestyle services join the partner directory: each service has the same directory details as a partner (a short
-- line, what it offers, its area and address, its website, and who to speak to there). As for partners, these are
-- the provider's business details, entered by staff; the person to ask for, their email and their number are
-- shown to members only.
ALTER TABLE lifestyle_services
  ADD COLUMN summary       TEXT NOT NULL DEFAULT '' CHECK (char_length(summary) <= 240),
  ADD COLUMN area          TEXT NOT NULL DEFAULT '' CHECK (char_length(area) <= 120),
  ADD COLUMN website       TEXT CHECK (website IS NULL OR char_length(website) <= 300),
  ADD COLUMN offer         TEXT NOT NULL DEFAULT '' CHECK (char_length(offer) <= 1000),
  ADD COLUMN contact_name  TEXT NOT NULL DEFAULT '' CHECK (char_length(contact_name) <= 120),
  ADD COLUMN contact_email TEXT NOT NULL DEFAULT '' CHECK (char_length(contact_email) <= 200),
  ADD COLUMN contact_phone TEXT NOT NULL DEFAULT '' CHECK (char_length(contact_phone) <= 40),
  ADD COLUMN address       TEXT NOT NULL DEFAULT '' CHECK (char_length(address) <= 240);
-- A service's description was its only text; its first sentence becomes the short line until staff write one.
UPDATE lifestyle_services SET summary = left(split_part(description, '. ', 1), 239) || CASE WHEN description LIKE '%. %' THEN '.' ELSE '' END WHERE summary = '';

-- 0032_push_renewals_insights.sql
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
