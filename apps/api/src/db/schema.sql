-- VSR Inventory — PostgreSQL schema
-- Ledger-based convenience-store inventory for Verifone Commander stores.
--
-- GOLDEN RULE (enforced by design, not just convention):
--   on-hand stock is NEVER stored as a column. For any (store_id, product_id),
--     on_hand = SUM(movements.qty_delta)
--   The view `store_product_on_hand` below is the single place that computes it.
--   Movements are append-only: an UPDATE/DELETE on `movements` is blocked by
--   trigger (see bottom of this file). Corrections go in as new movements
--   (type 'count-correction'), never by editing history.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- stores
CREATE TABLE IF NOT EXISTS stores (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code          TEXT NOT NULL UNIQUE,          -- e.g. 'STORE-001'
  name          TEXT NOT NULL,                 -- e.g. 'BNK Oil — Commerce Township'
  city          TEXT,
  state         TEXT,
  address       TEXT,
  is_home       BOOLEAN NOT NULL DEFAULT FALSE, -- home / first store
  register_id   TEXT,                          -- Commander register id, when known
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -------------------------------------------------------------- products
CREATE TABLE IF NOT EXISTS products (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  barcode     TEXT NOT NULL UNIQUE,            -- UPC/EAN as printed on the pack
  name        TEXT NOT NULL,
  category    TEXT,                            -- e.g. 'Beverage', 'Snack', 'Tobacco'
  cost_cents  INTEGER NOT NULL CHECK (cost_cents >= 0),
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -------------------------------------------------------- product_stores
-- Per-store shelf price, target margin and par (reorder-to) level.
-- price_cents here is the shelf price; margin_pct is the target margin used
-- when repricing from cost via priceFromCost(). They need not reconcile
-- exactly for demo SKUs (shelf prices were set by the store, not by formula).
CREATE TABLE IF NOT EXISTS product_stores (
  store_id    UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  product_id  UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  margin_pct  NUMERIC(6,2) NOT NULL DEFAULT 30 CHECK (margin_pct >= 0),
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  par_qty     INTEGER NOT NULL DEFAULT 0 CHECK (par_qty >= 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, product_id)
);

-- -------------------------------------------------------------- movements
-- Append-only inventory ledger. Every stock change is a row here.
-- qty_delta: positive = stock in, negative = stock out.
CREATE TABLE IF NOT EXISTS movements (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id    UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  product_id  UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN (
                  'receive', 'sale', 'waste', 'damage', 'expired',
                  'shrinkage', 'transfer-out', 'return', 'count-correction'
                )),
  qty_delta   INTEGER NOT NULL CHECK (qty_delta <> 0),
  cost_cents  INTEGER CHECK (cost_cents IS NULL OR cost_cents >= 0),
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_movements_store_product
  ON movements (store_id, product_id, created_at);
CREATE INDEX IF NOT EXISTS idx_movements_created_at ON movements (created_at);

-- Append-only enforcement: history is never edited, only corrected
-- by a new 'count-correction' movement.
CREATE OR REPLACE FUNCTION forbid_movement_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'movements is append-only: post a count-correction instead of editing history';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_movements_no_update ON movements;
CREATE TRIGGER trg_movements_no_update
  BEFORE UPDATE OR DELETE ON movements
  FOR EACH ROW EXECUTE FUNCTION forbid_movement_mutation();

-- -------------------------------------------------------- pos_transactions
-- One row per POS sale transaction. transaction_id is UNIQUE so a retried
-- or replayed Commander transaction can never double-post sales.
CREATE TABLE IF NOT EXISTS pos_transactions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id TEXT NOT NULL UNIQUE,        -- Commander transaction id
  store_id       UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  register_id    TEXT,
  total_cents    INTEGER NOT NULL CHECK (total_cents >= 0),
  source         TEXT NOT NULL DEFAULT 'commander-simulated',
  occurred_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pos_transactions_store_created
  ON pos_transactions (store_id, created_at);

-- -------------------------------------------------------------- pos_events
-- Per-line POS outcomes that need a human look: a scanned UPC with no
-- catalog match, or a line whose qty exceeds on-hand (blocked, never
-- allowed to drive stock negative). The sale line is NOT posted in
-- those cases; the event is the audit trail.
CREATE TABLE IF NOT EXISTS pos_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id TEXT,
  store_id       UUID REFERENCES stores(id) ON DELETE CASCADE,
  product_id     UUID REFERENCES products(id) ON DELETE SET NULL,
  upc            TEXT,
  event_type     TEXT NOT NULL CHECK (event_type IN (
                   'unmatched', 'insufficient_stock', 'duplicate'
                 )),
  detail         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pos_events_store_created
  ON pos_events (store_id, created_at);

-- ------------------------------------------------------------ cycle_counts
-- Blind cycle counts. variance_qty is derived, never typed in.
CREATE TABLE IF NOT EXISTS cycle_counts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id     UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  product_id   UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  expected_qty INTEGER NOT NULL CHECK (expected_qty >= 0),
  counted_qty  INTEGER NOT NULL CHECK (counted_qty >= 0),
  variance_qty INTEGER GENERATED ALWAYS AS (counted_qty - expected_qty) STORED,
  counted_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cycle_counts_store_product
  ON cycle_counts (store_id, product_id, created_at);

-- ------------------------------------------------------ price_book_imports
-- Audit row for every Commander price-book pull/import.
CREATE TABLE IF NOT EXISTS price_book_imports (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id      UUID REFERENCES stores(id) ON DELETE SET NULL,
  source        TEXT NOT NULL DEFAULT 'commander-simulated',
  added_count   INTEGER NOT NULL DEFAULT 0 CHECK (added_count >= 0),
  skipped_count INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  detail        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------ invoice_scans
-- An invoice OCR result is a DRAFT until a human confirms lines.
-- Nothing posts to the ledger from a scan alone (see invoice_lines).
CREATE TABLE IF NOT EXISTS invoice_scans (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id       UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  supplier       TEXT,
  invoice_number TEXT,
  status         TEXT NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft', 'confirmed', 'void')),
  raw            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------ invoice_lines
-- One row per OCR'd invoice line. `confirmed` is set only by an explicit
-- human confirm call; only confirmed + matched lines ever become
-- 'receive' movements. Unmatched lines can never be confirmed.
CREATE TABLE IF NOT EXISTS invoice_lines (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_scan_id UUID NOT NULL REFERENCES invoice_scans(id) ON DELETE CASCADE,
  product_id      UUID REFERENCES products(id) ON DELETE SET NULL,
  name            TEXT NOT NULL,
  barcode         TEXT,
  qty             INTEGER NOT NULL CHECK (qty > 0),
  unit_cost_cents INTEGER NOT NULL CHECK (unit_cost_cents >= 0),
  status          TEXT NOT NULL DEFAULT 'unmatched'
                  CHECK (status IN ('matched', 'unmatched')),
  confirmed       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invoice_lines_scan
  ON invoice_lines (invoice_scan_id);

-- =================================================================== VIEWS
-- The single source of truth for on-hand stock.
CREATE OR REPLACE VIEW store_product_on_hand AS
SELECT
  store_id,
  product_id,
  COALESCE(SUM(qty_delta), 0)::INTEGER AS on_hand,
  COUNT(*)::INTEGER AS movement_count,
  MAX(created_at) AS last_movement_at
FROM movements
GROUP BY store_id, product_id;

-- Convenience: every stocked product at every store, with on-hand (0 when
-- no movements exist yet) and par level for low-stock checks.
CREATE OR REPLACE VIEW store_inventory AS
SELECT
  ps.store_id,
  ps.product_id,
  p.barcode,
  p.name,
  p.category,
  p.cost_cents,
  ps.price_cents,
  ps.margin_pct,
  ps.par_qty,
  COALESCE(oh.on_hand, 0)::INTEGER AS on_hand
FROM product_stores ps
JOIN products p ON p.id = ps.product_id
LEFT JOIN store_product_on_hand oh
  ON oh.store_id = ps.store_id AND oh.product_id = ps.product_id;
