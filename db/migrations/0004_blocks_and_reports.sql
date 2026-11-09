-- Member safety: blocking another member, and reporting a concern to staff.

-- A block hides each member from the other everywhere: directory, profile, connections and messages.
CREATE TABLE member_blocks (
  blocker_id UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  blocked_id UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
CREATE INDEX member_blocks_blocked_idx ON member_blocks (blocked_id);

-- A report is read by staff only. The reported member is never told who sent it.
CREATE TABLE member_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  reported_id UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (reason IN ('unwanted_contact', 'misrepresentation', 'unsolicited_investment', 'other')),
  detail TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'dismissed', 'suspended')),
  resolved_by UUID REFERENCES users(id),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (reporter_id <> reported_id)
);
-- One open report per pair, so a concern cannot be multiplied to pressure staff.
CREATE UNIQUE INDEX member_reports_open_idx ON member_reports (reporter_id, reported_id) WHERE status = 'open';
CREATE INDEX member_reports_status_idx ON member_reports (status, created_at);
