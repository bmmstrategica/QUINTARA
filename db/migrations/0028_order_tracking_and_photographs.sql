-- Maison Quintara order tracking, and high-resolution photographs.

-- Every step of an order, when it happened and who recorded it: placed, paid, processing, dispatched for delivery,
-- received, and also cancellations, refunds and staff notes. The buyer sees the steps; staff notes stay internal.
CREATE TABLE order_events (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id   UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('placed', 'paid', 'preparing', 'dispatched', 'delivered', 'cancelled', 'refunded', 'note')),
  note       TEXT NOT NULL DEFAULT '' CHECK (char_length(note) <= 1000),
  actor_id   UUID REFERENCES users(id),          -- the buyer, a member of staff, or NULL when Quintara did it itself
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX order_events_order_idx ON order_events (order_id, created_at);

-- Who took the parcel in, recorded when the order is marked received.
ALTER TABLE orders ADD COLUMN received_by TEXT CHECK (received_by IS NULL OR char_length(received_by) <= 120);

-- Orders placed before this change: their placing, their payment, and the step they are at now.
INSERT INTO order_events (order_id, kind, actor_id, created_at) SELECT id, 'placed', user_id, created_at FROM orders;
INSERT INTO order_events (order_id, kind, actor_id, created_at)
  SELECT o.id, 'paid', o.user_id, COALESCE((SELECT min(p.paid_at) FROM payments p WHERE p.order_id = o.id), o.updated_at)
    FROM orders o WHERE o.status IN ('paid', 'preparing', 'dispatched', 'delivered')
       OR (o.status = 'cancelled' AND EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.paid_at IS NOT NULL));
INSERT INTO order_events (order_id, kind, created_at) SELECT id, status, updated_at FROM orders WHERE status IN ('preparing', 'dispatched', 'delivered', 'cancelled');

-- Photographs: the stored master's size, and the smaller copies made for screens of different widths.
ALTER TABLE media ADD COLUMN width INT CHECK (width IS NULL OR width > 0), ADD COLUMN height INT CHECK (height IS NULL OR height > 0);
CREATE TABLE media_variants (
  media_id     UUID NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  width        INT NOT NULL CHECK (width > 0),
  height       INT NOT NULL CHECK (height > 0),
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  byte_size    INT NOT NULL CHECK (byte_size > 0),
  data_base64  TEXT NOT NULL,
  PRIMARY KEY (media_id, content_type, width)
);
