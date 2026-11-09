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
