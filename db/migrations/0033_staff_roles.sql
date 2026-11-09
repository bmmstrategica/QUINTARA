-- Quintara, migration 0033: the full set of admin console roles.
-- `admin` (Super Administrator) and `concierge` (Concierge Manager) already exist. What each role may do is defined in
-- the domain package (STAFF_ROLE_PERMISSIONS) and checked by the API on every request; the database holds the keys.
-- Staff keys never reuse a member role key: `executive` is a member's business role (migration 0008).
INSERT INTO roles (key, is_staff) VALUES
  ('executive_admin', true), ('membership', true), ('experiences', true), ('finance', true), ('content', true), ('support', true);
-- No ON CONFLICT: a key that already exists (as a member role, say) must stop the migration, not be quietly skipped.

-- One role per admin console account: a person holds at most one staff role at a time.
CREATE UNIQUE INDEX IF NOT EXISTS user_roles_one_staff_role_idx ON user_roles (user_id)
  WHERE role_key IN ('admin', 'executive_admin', 'membership', 'experiences', 'concierge', 'finance', 'content', 'support');
