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
