-- The Boutique: a small shop for members. Products, wishlists and orders.

CREATE TABLE products (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id     UUID NOT NULL REFERENCES markets(id),
  title         TEXT NOT NULL CHECK (char_length(title) BETWEEN 2 AND 120),
  maker         TEXT NOT NULL DEFAULT '',
  category      TEXT NOT NULL CHECK (char_length(category) BETWEEN 2 AND 60),   -- free text, set by staff
  description   TEXT NOT NULL DEFAULT '',
  price_minor   BIGINT NOT NULL CHECK (price_minor > 0),
  currency_code CHAR(3) NOT NULL REFERENCES currencies(code),
  options       TEXT[] NOT NULL DEFAULT '{}',          -- e.g. colours or sizes; empty when there is one version
  stock         INT CHECK (stock IS NULL OR stock >= 0),   -- NULL: made to order, no limit
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE wishlist_items (
  member_id  UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, product_id)
);

CREATE SEQUENCE order_number_seq START 20431;

CREATE TABLE orders (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id        UUID NOT NULL REFERENCES markets(id),
  member_id        UUID NOT NULL REFERENCES members(id),
  order_number     TEXT NOT NULL UNIQUE,
  status           TEXT NOT NULL DEFAULT 'awaiting_payment' CHECK (status IN ('awaiting_payment', 'paid', 'preparing', 'dispatched', 'delivered', 'cancelled')),
  total_minor      BIGINT NOT NULL CHECK (total_minor > 0),
  currency_code    CHAR(3) NOT NULL REFERENCES currencies(code),
  delivery_name    TEXT NOT NULL,
  delivery_address TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX orders_member_idx ON orders (member_id, created_at DESC);
CREATE INDEX orders_status_idx ON orders (status, created_at);

-- The title and price are copied onto the line, so an order never changes when the product does.
CREATE TABLE order_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id       UUID NOT NULL REFERENCES products(id),
  title            TEXT NOT NULL,
  option           TEXT NOT NULL DEFAULT '',
  quantity         INT NOT NULL CHECK (quantity BETWEEN 1 AND 20),
  unit_price_minor BIGINT NOT NULL CHECK (unit_price_minor > 0)
);
CREATE INDEX order_items_order_idx ON order_items (order_id);

ALTER TABLE payments ADD COLUMN order_id UUID REFERENCES orders(id);
CREATE INDEX payments_order_idx ON payments (order_id) WHERE order_id IS NOT NULL;
