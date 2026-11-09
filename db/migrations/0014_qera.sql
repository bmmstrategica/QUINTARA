-- QÉRA: the member's conversation with the assistant, and the actions it has proposed.

CREATE TABLE qera_messages (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('member', 'qera')),
  body       TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX qera_messages_user_idx ON qera_messages (user_id, created_at);

-- An action is never taken on the assistant's say-so. It waits here until the member confirms it, and lapses if they do not.
CREATE TABLE qera_proposals (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool       TEXT NOT NULL,
  args       JSONB NOT NULL,
  summary    TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'cancelled', 'superseded', 'failed')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX qera_proposals_one_pending_uq ON qera_proposals (user_id) WHERE status = 'pending';
