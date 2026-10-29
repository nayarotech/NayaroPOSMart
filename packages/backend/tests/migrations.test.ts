import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/database';
import { currentSchemaVersion, LATEST_SCHEMA_VERSION, pendingMigrations, runMigrations } from '../src/db/migrations';
import { tmpDir } from './helpers';

const REQUIRED_TABLES = [
  'categories', 'products', 'product_barcodes', 'product_prices', 'suppliers', 'purchases', 'purchase_items',
  'stock_movements', 'sales', 'sale_items', 'payments', 'sales_returns', 'sales_return_items', 'users',
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
});
