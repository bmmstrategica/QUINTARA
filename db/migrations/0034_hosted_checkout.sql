-- Quintara, migration 0034: paying through a provider's hosted checkout.
-- A pending payment can carry the provider's checkout: the webhook and the member's return find the payment by its
-- reference, and asking to pay again reuses the same checkout page rather than opening a second one.
ALTER TABLE payments ADD COLUMN checkout_ref TEXT, ADD COLUMN checkout_url TEXT;
CREATE UNIQUE INDEX payments_checkout_ref_uq ON payments (provider, checkout_ref) WHERE checkout_ref IS NOT NULL;
