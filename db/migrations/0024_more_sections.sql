-- More sections whose descriptions staff can edit from the admin console: Experiences, Business, the relationship
-- manager, People to meet, Lifestyle services, the partner directory, Quintara TV, the membership application,
-- the guest account and Notifications. Until a section is written here, the apps show Quintara's default wording.
ALTER TABLE section_copy DROP CONSTRAINT IF EXISTS section_copy_key_check;
ALTER TABLE section_copy ADD CONSTRAINT section_copy_key_check CHECK (key IN (
  'qera', 'club', 'concierge', 'lifestyle', 'privileges', 'boutique', 'bookings', 'messaging', 'curator',
  'experiences', 'business', 'relationship', 'matching', 'services', 'partners', 'tv', 'membership', 'guest', 'notifications'));
