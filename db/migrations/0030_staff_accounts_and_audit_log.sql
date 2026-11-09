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
