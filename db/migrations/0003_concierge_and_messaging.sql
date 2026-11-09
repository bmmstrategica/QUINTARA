-- Quintara, migration 0003: concierge requests and member-to-member messaging.

CREATE TABLE concierge_requests (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id   UUID NOT NULL REFERENCES members(id),
  market_id   UUID NOT NULL REFERENCES markets(id),
  category    TEXT NOT NULL CHECK (category IN ('hospitality', 'travel', 'wellness', 'personal', 'entertainment')),
  subject     TEXT NOT NULL CHECK (char_length(subject) BETWEEN 3 AND 120),
  details     TEXT NOT NULL CHECK (char_length(details) BETWEEN 10 AND 2000),
  needed_by   DATE,
  status      TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'reviewing', 'options_provided', 'confirmed', 'completed', 'cancelled')),
  assigned_to UUID REFERENCES users(id),
  source      TEXT NOT NULL DEFAULT 'member' CHECK (source IN ('member', 'qera', 'admin')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX concierge_member_idx ON concierge_requests (member_id, created_at DESC);
CREATE INDEX concierge_queue_idx  ON concierge_requests (market_id, status, created_at) WHERE status NOT IN ('completed', 'cancelled');

-- The conversation inside a request, between the member and the desk.
CREATE TABLE concierge_messages (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id     UUID NOT NULL REFERENCES concierge_requests(id) ON DELETE CASCADE,
  sender_user_id UUID NOT NULL REFERENCES users(id),
  from_desk      BOOLEAN NOT NULL,
  body           TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX concierge_messages_idx ON concierge_messages (request_id, created_at);

-- One conversation per pair of members. Storing the pair in a fixed order makes the pair unique.
CREATE TABLE conversations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_low      UUID NOT NULL REFERENCES members(id),
  member_high     UUID NOT NULL REFERENCES members(id),
  last_message_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (member_low < member_high),
  UNIQUE (member_low, member_high)
);
CREATE INDEX conversations_high_idx ON conversations (member_high);

CREATE TABLE conversation_reads (
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  member_id       UUID NOT NULL REFERENCES members(id),
  last_read_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, member_id)
);

CREATE TABLE messages (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_member_id UUID NOT NULL REFERENCES members(id),
  body             TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX messages_thread_idx ON messages (conversation_id, created_at);
