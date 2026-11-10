-- The fee offered when an application is approved, kept with it: a later change to the plan's price applies to
-- applications approved from then on, never to an applicant already asked to pay. Earlier approvals keep using the
-- plan's price (null here).
ALTER TABLE membership_applications ADD COLUMN offered_price_minor BIGINT CHECK (offered_price_minor >= 0);
