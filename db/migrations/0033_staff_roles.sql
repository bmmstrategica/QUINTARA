-- Quintara, migration 0033: the full set of admin console roles.
-- `admin` (Super Administrator) and `concierge` (Concierge Manager) already exist. What each role may do is defined in
-- the domain package (STAFF_ROLE_PERMISSIONS) and checked by the API on every request; the database holds the keys.
INSERT INTO roles (key, is_staff) VALUES
  ('executive', true), ('membership', true), ('experiences', true), ('finance', true), ('content', true), ('support', true)
ON CONFLICT (key) DO NOTHING;

-- One role per admin console account: a person holds at most one staff role at a time.
CREATE UNIQUE INDEX IF NOT EXISTS user_roles_one_staff_role_idx ON user_roles (user_id)
  WHERE role_key IN ('admin', 'executive', 'membership', 'experiences', 'concierge', 'finance', 'content', 'support');
