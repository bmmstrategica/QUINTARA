-- Business: the four professional roles, listings, and introductions made by the Quintara team.

-- "Creator" becomes "creative", and "executive" is added. Both are granted by staff, like founder and investor.
INSERT INTO roles (key, is_staff) VALUES ('creative', false), ('executive', false) ON CONFLICT (key) DO NOTHING;
UPDATE user_roles SET role_key = 'creative' WHERE role_key = 'creator';
DELETE FROM roles WHERE key = 'creator';

-- A listing says what a member is looking for or offering. It carries no price, valuation or terms:
-- Quintara introduces people and takes no part in any transaction between them.
CREATE TABLE business_listings (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id   UUID NOT NULL REFERENCES markets(id),
  member_id   UUID NOT NULL REFERENCES members(id),
  kind        TEXT NOT NULL CHECK (kind IN ('capital', 'partnership', 'collaboration', 'advisory')),
  title       TEXT NOT NULL CHECK (char_length(title) BETWEEN 4 AND 120),
  summary     TEXT NOT NULL CHECK (char_length(summary) BETWEEN 20 AND 1200),
  sector      TEXT NOT NULL DEFAULT '',
  -- Which roles may see it. A listing about raising capital is always investors only.
  audience    TEXT[] NOT NULL CHECK (cardinality(audience) >= 1 AND audience <@ ARRAY['founder', 'investor', 'creative', 'executive']),
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published', 'declined', 'closed')),
  review_note TEXT,
  reviewed_by UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (kind <> 'capital' OR audience = ARRAY['investor'])
);
CREATE INDEX business_listings_status_idx ON business_listings (status, created_at DESC);
CREATE INDEX business_listings_member_idx ON business_listings (member_id);

-- An introduction passes through the team, then needs the other member's consent. Nothing is shared before that.
CREATE TABLE introductions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id UUID NOT NULL REFERENCES members(id),
  target_id    UUID NOT NULL REFERENCES members(id),
  listing_id   UUID REFERENCES business_listings(id),
  note         TEXT NOT NULL CHECK (char_length(note) BETWEEN 20 AND 1000),
  status       TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'offered', 'accepted', 'declined', 'not_progressed', 'withdrawn')),
  handled_by   UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (requester_id <> target_id)
);
-- One open request per pair and listing, so a member cannot be pressed repeatedly.
CREATE UNIQUE INDEX introductions_open_uq ON introductions (requester_id, target_id) WHERE status IN ('requested', 'offered');
CREATE INDEX introductions_target_idx ON introductions (target_id, status);
CREATE INDEX introductions_status_idx ON introductions (status, created_at);
