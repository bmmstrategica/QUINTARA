-- QÉRA Intelligence Core: the model gateway's settings and call log, versioned prompts, the knowledge base QÉRA
-- answers from, and members' feedback on its replies. Everything here is managed from the QÉRA Control Centre.

-- One row: how QÉRA runs. Changed only by an administrator; every change is written to the audit log.
CREATE TABLE qera_settings (
  id                   BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  -- Providers in the order they are tried. Any not configured on the server (no API key) is skipped.
  provider_order       TEXT[] NOT NULL DEFAULT ARRAY['anthropic', 'openai', 'gemini'],
  -- The model to ask at each provider. Checked against the provider's own documentation before production.
  models               JSONB NOT NULL DEFAULT '{"anthropic": "claude-sonnet-5-5", "openai": "gpt-6.1-sol", "gemini": "gemini-3.1-pro-preview"}',
  -- Off: QÉRA uses the built-in rule-based model only, and no member text leaves Quintara's servers.
  llm_enabled          BOOLEAN NOT NULL DEFAULT FALSE,
  knowledge_enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  proactive_enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  -- 1 informational, 2 assisted planning, 3 approval-based execution, 4 limited delegated automation (not yet offered).
  autonomy_level       SMALLINT NOT NULL DEFAULT 3 CHECK (autonomy_level BETWEEN 1 AND 3),
  -- Once the day's estimated model spend reaches this (US cents), QÉRA falls back to the rule-based model.
  daily_cost_cap_cents INT NOT NULL DEFAULT 5000 CHECK (daily_cost_cap_cents BETWEEN 0 AND 10000000),
  -- Per member per hour, across every channel.
  member_hourly_limit  INT NOT NULL DEFAULT 60 CHECK (member_hourly_limit BETWEEN 1 AND 1000),
  -- Anything a proposal would cost above this (minor units, ZAR) goes to the Lifestyle Curator instead.
  escalate_above_minor BIGINT NOT NULL DEFAULT 5000000 CHECK (escalate_above_minor >= 0),
  updated_by           UUID REFERENCES users(id),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO qera_settings DEFAULT VALUES;

-- The words that tell a hosted model who QÉRA is. One version is live; earlier ones are kept to roll back to.
CREATE TABLE qera_prompt_versions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version    INT NOT NULL UNIQUE,
  body       TEXT NOT NULL CHECK (char_length(body) BETWEEN 50 AND 20000),
  note       TEXT NOT NULL DEFAULT '' CHECK (char_length(note) <= 300),
  is_live    BOOLEAN NOT NULL DEFAULT FALSE,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX qera_prompt_one_live_uq ON qera_prompt_versions (is_live) WHERE is_live;

-- Every call to a hosted model: who it was for, which provider, how long, how many tokens, the estimated cost,
-- and whether it failed. The member's words are not stored here.
CREATE TABLE qera_model_calls (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  ok            BOOLEAN NOT NULL,
  error         TEXT,
  latency_ms    INT NOT NULL,
  input_tokens  INT NOT NULL DEFAULT 0,
  output_tokens INT NOT NULL DEFAULT 0,
  -- Hundredths of a US cent, so small calls are not rounded to nothing.
  cost_micro    BIGINT NOT NULL DEFAULT 0,
  tool          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX qera_model_calls_day_idx ON qera_model_calls (created_at);
CREATE INDEX qera_model_calls_user_idx ON qera_model_calls (user_id, created_at);

-- What QÉRA is allowed to know. Only published entries are searched. `audience` decides who may be told:
-- public (guests and members) or members. Internal procedures are staff-only and never reach QÉRA.
CREATE TABLE qera_knowledge (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id   UUID REFERENCES markets(id),
  topic       TEXT NOT NULL CHECK (topic IN ('membership', 'experiences', 'lifestyle', 'concierge', 'maison', 'policies', 'cancellations', 'faq', 'partners', 'other')),
  title       TEXT NOT NULL CHECK (char_length(title) BETWEEN 3 AND 160),
  body        TEXT NOT NULL CHECK (char_length(body) BETWEEN 10 AND 20000),
  audience    TEXT NOT NULL DEFAULT 'member' CHECK (audience IN ('public', 'member', 'staff')),
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  version     INT NOT NULL DEFAULT 1,
  -- When someone should check it is still right.
  review_by   DATE,
  updated_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  search      TSVECTOR GENERATED ALWAYS AS (setweight(to_tsvector('english', title), 'A') || setweight(to_tsvector('english', body), 'B')) STORED
);
CREATE INDEX qera_knowledge_search_idx ON qera_knowledge USING GIN (search);
CREATE INDEX qera_knowledge_status_idx ON qera_knowledge (status, audience);

-- A member's thumbs up or down on one of QÉRA's replies, with an optional word on why.
CREATE TABLE qera_feedback (
  message_id  UUID PRIMARY KEY REFERENCES qera_messages(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  helpful     BOOLEAN NOT NULL,
  comment     TEXT NOT NULL DEFAULT '' CHECK (char_length(comment) <= 500),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Which model answered each of QÉRA's replies, so quality can be compared between them.
ALTER TABLE qera_messages ADD COLUMN model TEXT;

-- Bookings QÉRA made (after the member confirmed), so revenue attributable to QÉRA can be reported.
ALTER TABLE experience_bookings ADD COLUMN source TEXT NOT NULL DEFAULT 'member' CHECK (source IN ('member', 'qera', 'admin'));
