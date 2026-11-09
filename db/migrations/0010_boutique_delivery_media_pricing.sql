-- Boutique: delivery charges, courier tracking, product photographs and member pricing.

-- Delivery methods and their fees are set by staff, per market.
CREATE TABLE delivery_options (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id       UUID NOT NULL REFERENCES markets(id),
  name            TEXT NOT NULL CHECK (char_length(name) BETWEEN 2 AND 80),
  description     TEXT NOT NULL DEFAULT '',
  fee_minor       BIGINT NOT NULL DEFAULT 0 CHECK (fee_minor >= 0),
  free_over_minor BIGINT CHECK (free_over_minor IS NULL OR free_over_minor > 0),   -- goods total from which delivery is free
  currency_code   CHAR(3) NOT NULL REFERENCES currencies(code),
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (market_id, name)
);

-- The fee and the method's name are copied onto the order, so later changes to a method never alter an order.
ALTER TABLE orders
  ADD COLUMN delivery_option_id UUID REFERENCES delivery_options(id),
  ADD COLUMN delivery_label     TEXT NOT NULL DEFAULT '',
  ADD COLUMN delivery_fee_minor BIGINT NOT NULL DEFAULT 0 CHECK (delivery_fee_minor >= 0),
  ADD COLUMN courier            TEXT,
  ADD COLUMN tracking_number    TEXT,
  ADD COLUMN tracking_url       TEXT;

-- Photographs. This table is the stand-in store; the MediaStore interface lets object storage replace it.
CREATE TABLE media (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  byte_size    INT NOT NULL CHECK (byte_size > 0),
  data_base64  TEXT NOT NULL,
  uploaded_by  UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE products
  ADD COLUMN image_id           UUID REFERENCES media(id),
  -- What members pay, when it differs from the public price.
  ADD COLUMN member_price_minor BIGINT CHECK (member_price_minor IS NULL OR member_price_minor > 0),
  -- Members-only products are not shown to visitors at all.
  ADD COLUMN members_only       BOOLEAN NOT NULL DEFAULT false,
  ADD CONSTRAINT products_member_price_lower CHECK (member_price_minor IS NULL OR member_price_minor <= price_minor);
