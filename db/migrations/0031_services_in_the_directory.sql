-- Lifestyle services join the partner directory: each service has the same directory details as a partner (a short
-- line, what it offers, its area and address, its website, and who to speak to there). As for partners, these are
-- the provider's business details, entered by staff; the person to ask for, their email and their number are
-- shown to members only.
ALTER TABLE lifestyle_services
  ADD COLUMN summary       TEXT NOT NULL DEFAULT '' CHECK (char_length(summary) <= 240),
  ADD COLUMN area          TEXT NOT NULL DEFAULT '' CHECK (char_length(area) <= 120),
  ADD COLUMN website       TEXT CHECK (website IS NULL OR char_length(website) <= 300),
  ADD COLUMN offer         TEXT NOT NULL DEFAULT '' CHECK (char_length(offer) <= 1000),
  ADD COLUMN contact_name  TEXT NOT NULL DEFAULT '' CHECK (char_length(contact_name) <= 120),
  ADD COLUMN contact_email TEXT NOT NULL DEFAULT '' CHECK (char_length(contact_email) <= 200),
  ADD COLUMN contact_phone TEXT NOT NULL DEFAULT '' CHECK (char_length(contact_phone) <= 40),
  ADD COLUMN address       TEXT NOT NULL DEFAULT '' CHECK (char_length(address) <= 240);
-- A service's description was its only text; its first sentence becomes the short line until staff write one.
UPDATE lifestyle_services SET summary = left(split_part(description, '. ', 1), 239) || CASE WHEN description LIKE '%. %' THEN '.' ELSE '' END WHERE summary = '';
