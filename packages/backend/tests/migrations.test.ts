import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/database';
import { currentSchemaVersion, LATEST_SCHEMA_VERSION, MIGRATIONS, pendingMigrations, runMigrations } from '../src/db/migrations';
import { tmpDir } from './helpers';

const REQUIRED_TABLES = [
  'categories', 'products', 'product_barcodes', 'product_prices', 'suppliers', 'purchases', 'purchase_items',
  'stock_movements', 'sales', 'sale_items', 'payments', 'sales_returns', 'sales_return_items', 'users',
  'cash_shifts', 'cash_movements', 'checkout_carts',
  'audit_logs', 'receipt_sequences', 'app_settings', 'sync_outbox', 'fiscal_years', 'product_batches',
];

describe('migrations', () => {
  it('creates every required table on a fresh database and is idempotent', () => {
    const file = path.join(tmpDir(), 'm.sqlite');
    const db = openDatabase(file);
    expect(currentSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
    for (const t of REQUIRED_TABLES) expect(tables).toContain(t);
    expect(runMigrations(db).applied).toEqual([]);
    expect(pendingMigrations(db)).toEqual([]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    db.close();
    const again = openDatabase(file);
    expect(currentSchemaVersion(again)).toBe(LATEST_SCHEMA_VERSION);
    again.close();
  });

  it('enforces foreign keys', () => {
    const db = openDatabase(path.join(tmpDir(), 'fk.sqlite'));
    expect(() => db.prepare("INSERT INTO product_barcodes (product_id, code, symbology, source, is_primary, created_at) VALUES (999, 'X1', 'CODE128', 'internal', 1, 'now')").run()).toThrow(/FOREIGN KEY/);
    db.close();
  });
  it('upgrades a v2 database, backfills dated payments and restores payment immutability', () => {
    const db = openDatabase(path.join(tmpDir(), 'legacy.sqlite'), { migrate: false });
    try {
      db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
      for (const migration of MIGRATIONS.filter((m) => m.version <= 2)) {
        db.exec(migration.sql);
        db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(migration.version, migration.name, '2026-10-28');
      }
      db.exec(`
        INSERT INTO users (id, username, full_name, role, password_hash, created_at, updated_at)
          VALUES (1, 'owner', 'Owner', 'admin', 'fixture', '2026-10-28', '2026-10-28');
        INSERT INTO fiscal_years VALUES ('2083/84', '2026-07-17', '2027-07-16', 'computed', '2026-10-28');
        INSERT INTO sales (id, receipt_no, client_txn_id, fiscal_year, business_date, cashier_id, subtotal_paisa, total_paisa, created_at)
          VALUES (1, 'LEGACY/1', 'legacy-1', '2083/84', '2026-10-28', 1, 100, 100, '2026-10-28T12:00:00Z');
        INSERT INTO sales_returns (id, return_no, sale_id, fiscal_year, business_date, reason, restock, refund_paisa, created_by, created_at)
          VALUES (1, 'RETURN/1', 1, '2083/84', '2026-10-29', 'Return', 1, 50, 1, '2026-10-30T00:00:00Z');
        INSERT INTO payments (id, sale_id, return_id, kind, method, amount_paisa, created_by, created_at) VALUES
          (1, 1, NULL, 'payment', 'cash', 100, 1, '2026-10-28T12:00:00Z'),
          (2, 1, 1, 'refund', 'cash', 50, 1, '2026-10-30T00:00:00Z'),
          (3, 1, NULL, 'refund', 'cash', 50, 1, '2026-10-30T12:00:00Z');
      `);
      expect(runMigrations(db).applied).toEqual(MIGRATIONS.filter((m) => m.version > 2).map((m) => m.version));
      const rows = db.prepare('SELECT id, business_date FROM payments ORDER BY id').all();
      expect(rows).toEqual([
        { id: 1, business_date: '2026-10-28' },
        { id: 2, business_date: '2026-10-29' },
        { id: 3, business_date: (db.prepare("SELECT date('2026-10-30T12:00:00Z', 'localtime') d").get() as { d: string }).d },
      ]);
      expect(() => db.prepare("UPDATE payments SET business_date = '2026-01-01'").run()).toThrow(/immutable/);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      db.close();
    }
  });

});
