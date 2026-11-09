-- Lifestyle partners and the privileges they extend to members.

CREATE TABLE partners (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id   UUID NOT NULL REFERENCES markets(id),
  name        TEXT NOT NULL CHECK (char_length(name) BETWEEN 2 AND 120),
  category    TEXT NOT NULL CHECK (char_length(category) BETWEEN 2 AND 60),   -- free text, set by staff
  summary     TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  area        TEXT NOT NULL DEFAULT '',
  website     TEXT,
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (market_id, name)
);

CREATE TABLE privileges (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id      UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  title           TEXT NOT NULL CHECK (char_length(title) BETWEEN 2 AND 120),
  details         TEXT NOT NULL DEFAULT '',
  terms           TEXT NOT NULL DEFAULT '',
  valid_until     DATE,                                   -- NULL: no end date
  uses_per_member INT NOT NULL DEFAULT 1 CHECK (uses_per_member >= 0),   -- 0: no limit
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX privileges_partner_idx ON privileges (partner_id);

-- A redemption is the member's proof at the partner's door: a code, issued once per use.
CREATE TABLE privilege_redemptions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  privilege_id UUID NOT NULL REFERENCES privileges(id),
  member_id    UUID NOT NULL REFERENCES members(id),
  code         TEXT NOT NULL UNIQUE,
  redeemed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX privilege_redemptions_member_idx ON privilege_redemptions (member_id, redeemed_at DESC);
CREATE INDEX privilege_redemptions_privilege_idx ON privilege_redemptions (privilege_id);
