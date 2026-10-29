import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { runMigrations } from './migrations';

export type DB = Database.Database;

export interface OpenOptions {
  readonly?: boolean;
  migrate?: boolean;
}

/**
 * Opens the SQLite database with durability-oriented settings:
 * - WAL journal for crash safety with concurrent readers
 * - synchronous=FULL so a committed sale survives power loss
 * - foreign keys enforced
 */
export function openDatabase(file: string, opts: OpenOptions = {}): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file, { readonly: opts.readonly ?? false, fileMustExist: opts.readonly ?? false });
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  if (!opts.readonly) {
    if (file !== ':memory:') db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
  }
  if (opts.migrate !== false && !opts.readonly) runMigrations(db);
  return db;
}

/** Runs fn inside BEGIN IMMEDIATE so concurrent writers cannot interleave (receipt numbers, stock). */
export function tx<T>(db: DB, fn: () => T): T {
  return db.transaction(fn).immediate();
}

export const bool = (v: unknown) => v === 1 || v === true;
