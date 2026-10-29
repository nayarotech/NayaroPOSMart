import type Database from 'better-sqlite3';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Forward-only migrations. Never edit a released migration; add a new one.
 * Each migration runs inside its own transaction together with its version bump.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','cashier')),
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0,1)),
  default_password INTEGER NOT NULL DEFAULT 0 CHECK (default_password IN (0,1)),
  is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0,1)),
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE fiscal_years (
  code TEXT PRIMARY KEY,
  start_date TEXT NOT NULL UNIQUE,
  end_date TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('computed','manual')),
  created_at TEXT NOT NULL,
  CHECK (end_date >= start_date)
);

CREATE TABLE categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE id_sequences (
  name TEXT PRIMARY KEY,
  next_value INTEGER NOT NULL CHECK (next_value > 0)
);

CREATE TABLE products (
  id INTEGER PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category_id INTEGER REFERENCES categories(id) ON DELETE RESTRICT,
  brand TEXT,
  unit TEXT NOT NULL DEFAULT 'pcs',
  cost_paisa INTEGER NOT NULL CHECK (cost_paisa >= 0),
  price_paisa INTEGER NOT NULL CHECK (price_paisa > 0),
  qty_on_hand INTEGER NOT NULL DEFAULT 0,
  min_stock INTEGER NOT NULL DEFAULT 0 CHECK (min_stock >= 0),
  track_expiry INTEGER NOT NULL DEFAULT 0 CHECK (track_expiry IN (0,1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0,1)),
  price_changed_at TEXT,
  label_printed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_products_name ON products(name COLLATE NOCASE);
CREATE INDEX idx_products_category ON products(category_id);

CREATE TABLE product_barcodes (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  code TEXT NOT NULL UNIQUE,
  symbology TEXT NOT NULL CHECK (symbology IN ('EAN13','EAN8','UPCA','CODE128','OTHER')),
  source TEXT NOT NULL CHECK (source IN ('manufacturer','internal')),
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_barcodes_product ON product_barcodes(product_id);

CREATE TABLE product_prices (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  price_paisa INTEGER NOT NULL CHECK (price_paisa > 0),
  cost_paisa INTEGER NOT NULL CHECK (cost_paisa >= 0),
  effective_from TEXT NOT NULL,
  changed_by INTEGER REFERENCES users(id),
  reason TEXT
);
CREATE INDEX idx_prices_product ON product_prices(product_id, effective_from);

CREATE TABLE suppliers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  contact_name TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  pan_vat TEXT,
  notes TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE purchases (
  id INTEGER PRIMARY KEY,
  purchase_no TEXT NOT NULL UNIQUE,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  invoice_no TEXT NOT NULL,
  invoice_date TEXT NOT NULL,
  fiscal_year TEXT NOT NULL REFERENCES fiscal_years(code),
  total_paisa INTEGER NOT NULL CHECK (total_paisa >= 0),
  notes TEXT,
  received_at TEXT NOT NULL,
  received_by INTEGER NOT NULL REFERENCES users(id),
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (supplier_id, invoice_no)
);

CREATE TABLE purchase_items (
  id INTEGER PRIMARY KEY,
  purchase_id INTEGER NOT NULL REFERENCES purchases(id) ON DELETE RESTRICT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_cost_paisa INTEGER NOT NULL CHECK (unit_cost_paisa >= 0),
  line_total_paisa INTEGER NOT NULL CHECK (line_total_paisa >= 0),
  batch_no TEXT,
  expiry_date TEXT
);
CREATE INDEX idx_purchase_items_purchase ON purchase_items(purchase_id);

CREATE TABLE product_batches (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  purchase_item_id INTEGER REFERENCES purchase_items(id) ON DELETE RESTRICT,
  batch_no TEXT,
  expiry_date TEXT,
  qty_received INTEGER NOT NULL CHECK (qty_received > 0),
  qty_remaining INTEGER NOT NULL CHECK (qty_remaining >= 0),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_batches_product ON product_batches(product_id, expiry_date);

CREATE TABLE sales (
  id INTEGER PRIMARY KEY,
  receipt_no TEXT NOT NULL UNIQUE,
  client_txn_id TEXT NOT NULL UNIQUE,
  fiscal_year TEXT NOT NULL REFERENCES fiscal_years(code),
  business_date TEXT NOT NULL,
  cashier_id INTEGER NOT NULL REFERENCES users(id),
  customer_name TEXT,
  subtotal_paisa INTEGER NOT NULL CHECK (subtotal_paisa >= 0),
  discount_paisa INTEGER NOT NULL DEFAULT 0 CHECK (discount_paisa >= 0),
  order_discount_paisa INTEGER NOT NULL DEFAULT 0 CHECK (order_discount_paisa >= 0),
  tax_paisa INTEGER NOT NULL DEFAULT 0 CHECK (tax_paisa >= 0),
  tax_label TEXT,
  tax_rate_bp INTEGER NOT NULL DEFAULT 0,
  tax_inclusive INTEGER NOT NULL DEFAULT 0,
  total_paisa INTEGER NOT NULL CHECK (total_paisa >= 0),
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','voided','partially_returned','returned')),
  discount_approved_by INTEGER REFERENCES users(id),
  voided_at TEXT,
  voided_by INTEGER REFERENCES users(id),
  void_reason TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_sales_date ON sales(business_date);
CREATE INDEX idx_sales_fy ON sales(fiscal_year);

CREATE TABLE sale_items (
  id INTEGER PRIMARY KEY,
  sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  unit TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_paisa INTEGER NOT NULL CHECK (unit_price_paisa >= 0),
  unit_cost_paisa INTEGER NOT NULL CHECK (unit_cost_paisa >= 0),
  discount_paisa INTEGER NOT NULL DEFAULT 0 CHECK (discount_paisa >= 0),
  line_total_paisa INTEGER NOT NULL CHECK (line_total_paisa >= 0),
  tax_paisa INTEGER NOT NULL DEFAULT 0 CHECK (tax_paisa >= 0),
  gross_paisa INTEGER NOT NULL CHECK (gross_paisa >= 0),
  returned_quantity INTEGER NOT NULL DEFAULT 0,
  CHECK (returned_quantity >= 0 AND returned_quantity <= quantity)
);
CREATE INDEX idx_sale_items_sale ON sale_items(sale_id);
CREATE INDEX idx_sale_items_product ON sale_items(product_id);

CREATE TABLE sales_returns (
  id INTEGER PRIMARY KEY,
  return_no TEXT NOT NULL UNIQUE,
  sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
  fiscal_year TEXT NOT NULL REFERENCES fiscal_years(code),
  business_date TEXT NOT NULL,
  reason TEXT NOT NULL,
  restock INTEGER NOT NULL CHECK (restock IN (0,1)),
  refund_paisa INTEGER NOT NULL CHECK (refund_paisa >= 0),
  created_by INTEGER NOT NULL REFERENCES users(id),
  approved_by INTEGER REFERENCES users(id),
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE sales_return_items (
  id INTEGER PRIMARY KEY,
  return_id INTEGER NOT NULL REFERENCES sales_returns(id) ON DELETE RESTRICT,
  sale_item_id INTEGER NOT NULL REFERENCES sale_items(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  refund_paisa INTEGER NOT NULL CHECK (refund_paisa >= 0)
);

CREATE TABLE payments (
  id INTEGER PRIMARY KEY,
  sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
  return_id INTEGER REFERENCES sales_returns(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('payment','refund')),
  method TEXT NOT NULL,
  amount_paisa INTEGER NOT NULL CHECK (amount_paisa >= 0),
  tendered_paisa INTEGER,
  change_paisa INTEGER,
  reference TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_payments_sale ON payments(sale_id);

CREATE TABLE stock_movements (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  type TEXT NOT NULL CHECK (type IN ('opening','sale','purchase','return','void','adjustment')),
  quantity_delta INTEGER NOT NULL CHECK (quantity_delta <> 0),
  balance_after INTEGER NOT NULL,
  reason TEXT,
  ref_type TEXT,
  ref_id INTEGER,
  ref_label TEXT,
  user_id INTEGER REFERENCES users(id),
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  -- the same source line can only affect stock once per movement type
  UNIQUE (type, ref_type, ref_id)
);
CREATE INDEX idx_movements_product ON stock_movements(product_id, id);

CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  user_id INTEGER REFERENCES users(id),
  approved_by INTEGER REFERENCES users(id),
  details TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_action ON audit_logs(action, id);

CREATE TABLE receipt_sequences (
  sequence_key TEXT PRIMARY KEY,
  next_value INTEGER NOT NULL CHECK (next_value > 0),
  updated_at TEXT NOT NULL
);

CREATE TABLE sync_outbox (
  id INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','error')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_outbox_status ON sync_outbox(status, id);

-- ---------------------------------------------------------------------------
-- Data-protection triggers. Real (non-demo) financial records are append-only.
-- A wipe is only possible when the app writes the '__wipe_authorized' marker
-- inside the same transaction (explicit, admin-confirmed demo reset).
-- ---------------------------------------------------------------------------
CREATE TRIGGER trg_sales_no_delete BEFORE DELETE ON sales
WHEN OLD.is_demo = 0 AND NOT EXISTS (SELECT 1 FROM app_settings WHERE key = '__wipe_authorized')
BEGIN SELECT RAISE(ABORT, 'Completed sales cannot be deleted. Use a void or return instead.'); END;

CREATE TRIGGER trg_sales_amounts_immutable BEFORE UPDATE OF subtotal_paisa, discount_paisa, order_discount_paisa, tax_paisa, total_paisa, receipt_no, client_txn_id, fiscal_year, business_date, cashier_id ON sales
BEGIN SELECT RAISE(ABORT, 'Sale amounts and numbers are immutable after completion.'); END;

CREATE TRIGGER trg_sale_items_immutable BEFORE UPDATE OF product_id, quantity, unit_price_paisa, unit_cost_paisa, discount_paisa, line_total_paisa, tax_paisa, gross_paisa ON sale_items
BEGIN SELECT RAISE(ABORT, 'Sale item price snapshots are immutable.'); END;

CREATE TRIGGER trg_sale_items_no_delete BEFORE DELETE ON sale_items
WHEN (SELECT is_demo FROM sales WHERE id = OLD.sale_id) = 0 AND NOT EXISTS (SELECT 1 FROM app_settings WHERE key = '__wipe_authorized')
BEGIN SELECT RAISE(ABORT, 'Sale items cannot be deleted.'); END;

CREATE TRIGGER trg_payments_no_delete BEFORE DELETE ON payments
WHEN OLD.is_demo = 0 AND NOT EXISTS (SELECT 1 FROM app_settings WHERE key = '__wipe_authorized')
BEGIN SELECT RAISE(ABORT, 'Payment records cannot be deleted.'); END;

CREATE TRIGGER trg_payments_immutable BEFORE UPDATE ON payments
BEGIN SELECT RAISE(ABORT, 'Payment records are immutable.'); END;

CREATE TRIGGER trg_movements_immutable BEFORE UPDATE ON stock_movements
BEGIN SELECT RAISE(ABORT, 'Stock movements are immutable.'); END;

CREATE TRIGGER trg_movements_no_delete BEFORE DELETE ON stock_movements
WHEN OLD.is_demo = 0 AND NOT EXISTS (SELECT 1 FROM app_settings WHERE key = '__wipe_authorized')
BEGIN SELECT RAISE(ABORT, 'Stock movements cannot be deleted.'); END;

CREATE TRIGGER trg_audit_immutable BEFORE UPDATE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'Audit logs are append-only.'); END;

CREATE TRIGGER trg_audit_no_delete BEFORE DELETE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'Audit logs are append-only.'); END;
`,
  },
  {
    version: 2,
    name: 'promotions, customers and lucky-draw schemes',
    sql: `
CREATE TABLE promotions (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  percent_bp INTEGER NOT NULL CHECK (percent_bp BETWEEN 1 AND 9000),
  category_id INTEGER REFERENCES categories(id) ON DELETE RESTRICT,
  starts_on TEXT NOT NULL,
  ends_on TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (ends_on >= starts_on)
);

CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  consent_at TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE sales ADD COLUMN promo_discount_paisa INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sales ADD COLUMN customer_id INTEGER REFERENCES customers(id);
ALTER TABLE sale_items ADD COLUMN promo_discount_paisa INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sale_items ADD COLUMN promotion_id INTEGER REFERENCES promotions(id);
ALTER TABLE sale_items ADD COLUMN promotion_name TEXT;

CREATE TABLE schemes (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  min_bill_paisa INTEGER NOT NULL CHECK (min_bill_paisa > 0),
  entry_step_paisa INTEGER CHECK (entry_step_paisa IS NULL OR entry_step_paisa > 0),
  starts_on TEXT NOT NULL,
  ends_on TEXT NOT NULL,
  coupon_prefix TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (ends_on >= starts_on)
);

CREATE TABLE scheme_entries (
  id INTEGER PRIMARY KEY,
  scheme_id INTEGER NOT NULL REFERENCES schemes(id) ON DELETE RESTRICT,
  sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  coupon_no TEXT NOT NULL UNIQUE,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_entries_scheme ON scheme_entries(scheme_id);
CREATE INDEX idx_entries_sale ON scheme_entries(sale_id);

CREATE TABLE scheme_winners (
  id INTEGER PRIMARY KEY,
  scheme_id INTEGER NOT NULL REFERENCES schemes(id) ON DELETE RESTRICT,
  entry_id INTEGER NOT NULL UNIQUE REFERENCES scheme_entries(id) ON DELETE RESTRICT,
  rank INTEGER NOT NULL,
  prize TEXT NOT NULL,
  pool_size INTEGER NOT NULL,
  drawn_by INTEGER NOT NULL REFERENCES users(id),
  is_demo INTEGER NOT NULL DEFAULT 0,
  drawn_at TEXT NOT NULL,
  UNIQUE (scheme_id, rank)
);

CREATE TRIGGER trg_sale_items_promo_immutable BEFORE UPDATE OF promo_discount_paisa, promotion_id, promotion_name ON sale_items
BEGIN SELECT RAISE(ABORT, 'Sale item price snapshots are immutable.'); END;

CREATE TRIGGER trg_sales_promo_immutable BEFORE UPDATE OF promo_discount_paisa, customer_id ON sales
BEGIN SELECT RAISE(ABORT, 'Sale amounts and numbers are immutable after completion.'); END;

CREATE TRIGGER trg_entries_immutable BEFORE UPDATE ON scheme_entries
BEGIN SELECT RAISE(ABORT, 'Lucky-draw coupons cannot be changed.'); END;

CREATE TRIGGER trg_entries_no_delete BEFORE DELETE ON scheme_entries
WHEN OLD.is_demo = 0 AND NOT EXISTS (SELECT 1 FROM app_settings WHERE key = '__wipe_authorized')
BEGIN SELECT RAISE(ABORT, 'Lucky-draw coupons cannot be deleted.'); END;

CREATE TRIGGER trg_winners_immutable BEFORE UPDATE ON scheme_winners
BEGIN SELECT RAISE(ABORT, 'Draw results cannot be changed.'); END;

CREATE TRIGGER trg_winners_no_delete BEFORE DELETE ON scheme_winners
WHEN OLD.is_demo = 0 AND NOT EXISTS (SELECT 1 FROM app_settings WHERE key = '__wipe_authorized')
BEGIN SELECT RAISE(ABORT, 'Draw results cannot be deleted.'); END;
`,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

export function currentSchemaVersion(db: Database.Database): number {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
  if (!row) return 0;
  const v = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null };
  return v.v ?? 0;
}

export function pendingMigrations(db: Database.Database): Migration[] {
  const current = currentSchemaVersion(db);
  return MIGRATIONS.filter((m) => m.version > current);
}

export function runMigrations(db: Database.Database): { applied: number[] } {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const current = currentSchemaVersion(db);
  if (current > LATEST_SCHEMA_VERSION) {
    throw new Error(`Database schema v${current} is newer than this app (v${LATEST_SCHEMA_VERSION}). Install the newer app version.`);
  }
  const applied: number[] = [];
  for (const m of MIGRATIONS.filter((x) => x.version > current)) {
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, new Date().toISOString());
    }).immediate();
    applied.push(m.version);
  }
  const fk = db.pragma('foreign_key_check') as unknown[];
  if (fk.length) throw new Error(`Foreign key check failed after migration (${fk.length} problems)`);
  return { applied };
}
