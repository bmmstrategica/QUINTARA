-- The membership application: the plan an applicant applies for, the phone number (kept in the application data,
-- seen only by staff), and questions staff can reword or add.

-- Plans are membership tiers with a residency and a fixed term, paid once.
ALTER TABLE membership_tiers
  ADD COLUMN residency   TEXT CHECK (residency IN ('resident', 'international')),
  ADD COLUMN term_months INT CHECK (term_months BETWEEN 1 AND 60);

-- Markets priced in rand start with the standard plans. Other markets add their own under Tiers.
INSERT INTO membership_tiers (market_id, name, price_minor, currency_code, billing_period, residency, term_months)
SELECT m.id, p.name, p.price_minor, m.currency_code, 'once', p.residency, p.term_months
  FROM markets m CROSS JOIN (VALUES
    ('Resident, 3 months', 1000000, 'resident', 3), ('Resident, 6 months', 1800000, 'resident', 6), ('Resident, 12 months', 3000000, 'resident', 12),
    ('International, 1 month', 800000, 'international', 1), ('International, 3 months', 1600000, 'international', 3),
    ('International, 6 months', 2800000, 'international', 6), ('International, 12 months', 5000000, 'international', 12)
  ) AS p(name, price_minor, residency, term_months)
 WHERE m.currency_code = 'ZAR'
ON CONFLICT (market_id, name) DO NOTHING;

-- What the applicant asked for. Staff offer a tier on approval, normally this one.
ALTER TABLE membership_applications ADD COLUMN requested_tier_id UUID REFERENCES membership_tiers(id);

-- Staff wording for the built-in questions. A question with no row uses the default wording.
CREATE TABLE application_question_copy (
  id         UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  key        TEXT PRIMARY KEY CHECK (key IN ('email', 'fullName', 'phone', 'city', 'position', 'company', 'industry', 'roles', 'interests', 'motivation', 'referral', 'social', 'links', 'membership')),
  label      TEXT NOT NULL CHECK (char_length(label) BETWEEN 2 AND 160),
  help       TEXT NOT NULL DEFAULT '' CHECK (char_length(help) <= 300),
  options    JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Questions staff add. They are retired rather than deleted, so earlier answers keep their question.
CREATE TABLE application_questions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       TEXT NOT NULL CHECK (kind IN ('short_text', 'long_text', 'choice', 'multi_choice', 'yes_no')),
  label      TEXT NOT NULL CHECK (char_length(label) BETWEEN 2 AND 160),
  help       TEXT NOT NULL DEFAULT '' CHECK (char_length(help) <= 300),
  options    JSONB NOT NULL DEFAULT '[]'::jsonb,
  required   BOOLEAN NOT NULL DEFAULT false,
  is_active  BOOLEAN NOT NULL DEFAULT true,
  position   INT NOT NULL DEFAULT 100,
  created_by UUID REFERENCES users(id),
  updated_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
