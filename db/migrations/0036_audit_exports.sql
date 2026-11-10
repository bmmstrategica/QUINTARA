-- Quintara, migration 0036: daily copies of the audit log in write-once storage.
-- One row per day and log: what was copied, where, and the last hash, so the copies chain together as the log does.
CREATE TABLE audit_exports (
  day         DATE NOT NULL,
  log         TEXT NOT NULL CHECK (log IN ('audit_logs', 'staff_activity')),
  entries     INT NOT NULL CHECK (entries >= 0),
  first_seq   BIGINT,
  last_seq    BIGINT,
  last_hash   TEXT,
  object_key  TEXT NOT NULL,
  retain_until TIMESTAMPTZ NOT NULL,
  exported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (day, log)
);
