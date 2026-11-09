-- QÉRA as Chief of Staff: service packages, the member's memory, reminders, the weekly brief, and booking a whole plan.

-- Packages: what each lifestyle service offers, at what indicative price and with how much notice.
CREATE TABLE service_packages (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id       UUID NOT NULL REFERENCES lifestyle_services(id) ON DELETE CASCADE,
  name             TEXT NOT NULL CHECK (char_length(name) BETWEEN 2 AND 120),
  description      TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 600),
  price_minor      INTEGER CHECK (price_minor IS NULL OR price_minor >= 0),   -- NULL: price on request
  price_basis      TEXT NOT NULL DEFAULT 'per_booking' CHECK (price_basis IN ('per_person', 'per_session', 'per_booking', 'per_hour', 'per_day')),
  currency_code    CHAR(3) NOT NULL DEFAULT 'ZAR' REFERENCES currencies(code),
  lead_time_hours  INTEGER NOT NULL DEFAULT 48 CHECK (lead_time_hours BETWEEN 0 AND 8760),
  duration         TEXT NOT NULL DEFAULT '' CHECK (char_length(duration) <= 60),
  position         INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'published', 'archived')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX service_packages_service_idx ON service_packages (service_id, position);
-- A request keeps the package and the price as they were when it was made.
ALTER TABLE service_requests ADD COLUMN package_id UUID REFERENCES service_packages(id) ON DELETE SET NULL;
ALTER TABLE service_requests ADD COLUMN package_name TEXT;
ALTER TABLE service_requests ADD COLUMN price_label TEXT;

-- What QÉRA remembers about a member. Written only by the member, or by QÉRA after the member has confirmed.
CREATE TABLE qera_memory (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('dietary', 'likes', 'favourite', 'date', 'person', 'note')),
  label       TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 120),
  detail      TEXT NOT NULL DEFAULT '' CHECK (char_length(detail) <= 300),
  on_date     DATE,                                   -- for important dates
  source      TEXT NOT NULL DEFAULT 'member' CHECK (source IN ('member', 'qera')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX qera_memory_user_idx ON qera_memory (user_id, kind);

-- Reminders the member or QÉRA set, delivered as notifications.
CREATE TABLE qera_reminders (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text        TEXT NOT NULL CHECK (char_length(text) BETWEEN 2 AND 200),
  remind_at   TIMESTAMPTZ NOT NULL,
  status      TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'sent', 'cancelled')),
  source      TEXT NOT NULL DEFAULT 'member' CHECK (source IN ('member', 'qera')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at     TIMESTAMPTZ
);
CREATE INDEX qera_reminders_due_idx ON qera_reminders (remind_at) WHERE status = 'scheduled';

-- Things QÉRA tells a member of its own accord (the weekly brief, a date coming up, tomorrow's booking), each once.
CREATE TABLE qera_nudges (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nudge_key   TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, nudge_key)
);

-- The weekly brief can be switched off. NULL means the default, which is on.
ALTER TABLE privacy_settings ADD COLUMN weekly_brief BOOLEAN;

-- Booking a whole plan: what happened to each line, keyed by its position in the plan.
ALTER TABLE qera_documents ADD COLUMN booked JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Packages for the services already in place (a new database gets them from the seed instead).
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Portrait session', 'Portraits at a location of your choice, with a selection of edited images.', 350000, 'per_session', 72, '2 hours', 0 FROM lifestyle_services WHERE name = 'Suné Photography';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Event coverage', 'Photography of your event, edited and delivered as a private gallery.', 1200000, 'per_booking', 168, 'Up to 4 hours', 1 FROM lifestyle_services WHERE name = 'Suné Photography';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Content day', 'A day creating natural, personal content for social media.', 650000, 'per_day', 120, 'Full day', 2 FROM lifestyle_services WHERE name = 'Suné Photography';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Sunset cruise', 'A private yacht with crew for a sunset cruise.', 2500000, 'per_booking', 72, '3 hours', 0 FROM lifestyle_services WHERE name = 'One&Only Yacht Charter';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Full-day charter', 'A private yacht for the day, with crew and catering arranged around your party.', NULL, 'per_day', 168, 'Full day', 1 FROM lifestyle_services WHERE name = 'One&Only Yacht Charter';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Design consultation', 'A first visit to understand the space, how you live in it and what you would like.', 250000, 'per_session', 120, '90 minutes', 0 FROM lifestyle_services WHERE name = 'Vellora Interiors';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Room design', 'Concept, materials, furniture and finishing touches for one room.', NULL, 'per_booking', 336, '', 1 FROM lifestyle_services WHERE name = 'Vellora Interiors';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'A day with a luxury car', 'A luxury or performance car for the day.', 450000, 'per_day', 48, '24 hours', 0 FROM lifestyle_services WHERE name = 'Elite Motion';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Weekend', 'A luxury car from Friday to Sunday.', 1100000, 'per_booking', 72, 'Friday to Sunday', 1 FROM lifestyle_services WHERE name = 'Elite Motion';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Style consultation', 'Your wardrobe, image and personal brand, with clear recommendations.', 280000, 'per_session', 72, '2 hours', 0 FROM lifestyle_services WHERE name = 'Atelier Lunda';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Wardrobe edit', 'An edit of your wardrobe at home, with a list of what to keep, change and add.', 600000, 'per_session', 168, 'Half a day', 1 FROM lifestyle_services WHERE name = 'Atelier Lunda';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Personal training session', 'One session with a personal trainer.', 75000, 'per_session', 24, '1 hour', 0 FROM lifestyle_services WHERE name = 'Apex Performance';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Four-week programme', 'Training, nutrition guidance and coaching for four weeks.', 750000, 'per_booking', 72, '4 weeks', 1 FROM lifestyle_services WHERE name = 'Apex Performance';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Dinner for two', 'A private chef cooks a dinner for two where you are hosting.', 480000, 'per_booking', 120, 'Evening', 0 FROM lifestyle_services WHERE name = 'The Culinary House';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Tasting menu', 'A tasting menu cooked for your guests, designed with you.', 220000, 'per_person', 120, 'Evening', 1 FROM lifestyle_services WHERE name = 'The Culinary House';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Celebration', 'A menu for a larger celebration, up to twenty guests.', NULL, 'per_booking', 336, '', 2 FROM lifestyle_services WHERE name = 'The Culinary House';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Event make-up', 'Make-up for an event or evening out, where you are getting ready.', 150000, 'per_person', 48, '1 hour', 0 FROM lifestyle_services WHERE name = 'Éclat Atelier';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Bridal', 'Bridal make-up with a trial beforehand.', NULL, 'per_booking', 336, '', 1 FROM lifestyle_services WHERE name = 'Éclat Atelier';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Hydration drip', 'An IV drip for hydration, after a short consultation.', 180000, 'per_session', 24, '45 minutes', 0 FROM lifestyle_services WHERE name = 'Skye Health';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Recovery drip', 'An IV drip for recovery, after a short consultation.', 240000, 'per_session', 24, '60 minutes', 1 FROM lifestyle_services WHERE name = 'Skye Health';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Model booking', 'Models for a campaign, shoot or event.', NULL, 'per_day', 168, '', 0 FROM lifestyle_services WHERE name = 'Alpha Management';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Brand partnership consultation', 'A first meeting about your brand, your audience and the partnerships that would suit it.', 300000, 'per_session', 120, '1 hour', 0 FROM lifestyle_services WHERE name = 'EliteReach Management';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Creator campaign', 'A campaign with matched creators, planned and run from idea to results.', NULL, 'per_booking', 336, '', 1 FROM lifestyle_services WHERE name = 'EliteReach Management';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Introductory meeting', 'A first meeting with BMM Capital about your business or what you are looking for.', NULL, 'per_session', 72, '1 hour', 0 FROM lifestyle_services WHERE name = 'BMM Capital';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Promotion feature', 'A feature or advert placed with TheFeed''s audience.', NULL, 'per_booking', 168, '', 0 FROM lifestyle_services WHERE name = 'TheFeed';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Studio hire', 'A photography or videography studio for your own shoot.', 120000, 'per_hour', 48, 'Per hour', 0 FROM lifestyle_services WHERE name = 'Nava Studios';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Full production', 'Planning, crew, filming and editing for your project.', NULL, 'per_booking', 336, '', 1 FROM lifestyle_services WHERE name = 'Nava Studios';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Skin consultation', 'A consultation to recommend treatments for your skin and your goals.', 90000, 'per_session', 48, '45 minutes', 0 FROM lifestyle_services WHERE name = 'Novaderm Aesthetics';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Signature facial', 'A facial chosen for your skin.', 220000, 'per_session', 72, '75 minutes', 1 FROM lifestyle_services WHERE name = 'Novaderm Aesthetics';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Sauna session', 'A sauna session.', 45000, 'per_person', 4, '90 minutes', 0 FROM lifestyle_services WHERE name = 'Wonderland Cape Town';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Work and wellness day', 'A day at a desk with sauna access.', 65000, 'per_day', 24, 'Full day', 1 FROM lifestyle_services WHERE name = 'Wonderland Cape Town';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Overnight stay', 'A night at Wonderland.', NULL, 'per_booking', 48, 'One night', 2 FROM lifestyle_services WHERE name = 'Wonderland Cape Town';
INSERT INTO service_packages (service_id, name, description, price_minor, price_basis, lead_time_hours, duration, position) SELECT id, 'Day visit', 'A visit to the club''s gym and wellness facilities, on the club''s terms.', NULL, 'per_person', 24, 'Day', 0 FROM lifestyle_services WHERE name = 'Virgin Active Country Club';
