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
