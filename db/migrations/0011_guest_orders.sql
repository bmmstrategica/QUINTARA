-- Guests can order from the Boutique without a membership.
-- An order now belongs to a user (a member's account, or a guest's device account) and carries its own contact email.

ALTER TABLE orders ADD COLUMN user_id UUID REFERENCES users(id), ADD COLUMN contact_email TEXT;
UPDATE orders o SET user_id = m.user_id FROM members m WHERE m.id = o.member_id;
ALTER TABLE orders ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE orders ALTER COLUMN member_id DROP NOT NULL;
-- A guest order must say where to write to; a member's order uses the account's own address.
ALTER TABLE orders ADD CONSTRAINT orders_guest_has_email CHECK (member_id IS NOT NULL OR contact_email IS NOT NULL);
CREATE INDEX orders_user_idx ON orders (user_id, created_at DESC);
