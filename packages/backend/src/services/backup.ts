import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BackupInfo, BackupStatus, VerifyResult } from '@srmart/shared';
import type { DB } from '../db/database';
import { openDatabase } from '../db/database';
import { currentSchemaVersion, runMigrations } from '../db/migrations';
import { AppError, invalid, notFound } from '../errors';

const KEY_TABLES = ['products', 'product_barcodes', 'sales', 'sale_items', 'payments', 'stock_movements', 'purchases', 'users', 'audit_logs'];
const FILE_RE = /^srmart-\d{8}-\d{6}(-[a-z0-9-]+)?\.sqlite$/;

interface Sidecar {
  createdAt: string;
  reason: string;
  verified: boolean | null;
  schemaVersion?: number;
  tables?: Record<string, number>;
}

function stamp(d: Date) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function fsyncFile(file: string) {
  const fd = fs.openSync(file, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Integrity + content check of a database file, opened read-only so the file is never modified. */
export function verifyDatabaseFile(file: string): VerifyResult {
  let db: DB | null = null;
  try {
    db = openDatabase(file, { readonly: true, migrate: false });
    const integrity = (db.pragma('integrity_check', { simple: true }) as string) ?? 'unknown';
    const tables: Record<string, number> = {};
    for (const t of KEY_TABLES) {
      const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(t);
      tables[t] = exists ? (db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n : -1;
    }
    const schemaVersion = currentSchemaVersion(db);
    const ok = integrity === 'ok' && schemaVersion > 0 && Object.values(tables).every((n) => n >= 0);
    return { ok, integrity, tables, schemaVersion, message: ok ? 'Backup is readable and passed the integrity check' : 'Backup failed verification' };
  } catch (err) {
    return { ok: false, integrity: 'unreadable', tables: {}, schemaVersion: 0, message: `Could not open backup: ${(err as Error).message}` };
  } finally {
    db?.close();
  }
}

export class BackupService {
  constructor(
    private getDb: () => DB,
    private primaryPath: string,
    private resolveDir: () => string,
  ) {}

  dir(): string {
    const d = this.resolveDir();
    fs.mkdirSync(d, { recursive: true });
    if (path.resolve(d) === path.resolve(path.dirname(this.primaryPath))) {
      throw invalid('The backup folder must be different from the database folder');
    }
    return d;
  }

  /** Only bare file names inside the backup folder are accepted (no path traversal from the UI). */
  private resolveFile(file: string): string {
    const name = path.basename(String(file ?? ''));
    if (name !== file || !FILE_RE.test(name)) throw invalid('Invalid backup file name');
    const full = path.join(this.dir(), name);
    if (!fs.existsSync(full)) throw notFound('Backup file');
    return full;
  }

  private readSidecar(full: string): Sidecar | null {
    try {
      return JSON.parse(fs.readFileSync(`${full}.json`, 'utf8')) as Sidecar;
    } catch {
      return null;
    }
  }

  private writeSidecar(full: string, s: Sidecar) {
    const tmp = `${full}.json.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
    fs.renameSync(tmp, `${full}.json`);
  }

  /**
   * Creates a consistent snapshot with VACUUM INTO (safe while the app is running, includes WAL
   * contents), writes to a temp name, fsyncs, verifies, then renames. Never overwrites a file.
   */
  create(reason = 'manual', now = new Date()): BackupInfo {
    const dir = this.dir();
    const slug = reason.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'manual';
    let name = `srmart-${stamp(now)}-${slug}.sqlite`;
    for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `srmart-${stamp(now)}-${slug}-${i}.sqlite`;
    const final = path.join(dir, name);
    const tmp = path.join(dir, `.${name}.partial`);
    if (fs.existsSync(tmp)) fs.rmSync(tmp);
    this.getDb().prepare('VACUUM INTO ?').run(tmp);
    fsyncFile(tmp);
    const v = verifyDatabaseFile(tmp);
    if (!v.ok) {
      fs.rmSync(tmp, { force: true });
      throw new AppError('DATABASE', `Backup verification failed: ${v.message}`);
    }
    fs.renameSync(tmp, final);
    this.writeSidecar(final, { createdAt: now.toISOString(), reason, verified: true, schemaVersion: v.schemaVersion, tables: v.tables });
    return this.info(final);
  }

  private info(full: string): BackupInfo {
    const st = fs.statSync(full);
    const meta = this.readSidecar(full);
    return {
      file: path.basename(full),
      path: full,
      sizeBytes: st.size,
      createdAt: meta?.createdAt ?? st.mtime.toISOString(),
      reason: meta?.reason ?? 'unknown',
      verified: meta?.verified ?? null,
    };
  }

  list(): BackupInfo[] {
    const dir = this.dir();
    return fs
      .readdirSync(dir)
      .filter((f) => FILE_RE.test(f))
      .map((f) => this.info(path.join(dir, f)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  status(): BackupStatus {
    const dir = this.dir();
    let sameDriveWarning = false;
    try {
      sameDriveWarning = fs.statSync(dir).dev === fs.statSync(path.dirname(this.primaryPath)).dev;
    } catch {
      sameDriveWarning = true;
    }
    const backups = this.list();
    return { directory: dir, primaryDbPath: this.primaryPath, sameDriveWarning, backups, lastBackupAt: backups[0]?.createdAt ?? null };
  }

  verify(file: string): VerifyResult {
    const full = this.resolveFile(file);
    const v = verifyDatabaseFile(full);
    const meta = this.readSidecar(full) ?? { createdAt: fs.statSync(full).mtime.toISOString(), reason: 'unknown', verified: null };
    this.writeSidecar(full, { ...meta, verified: v.ok, schemaVersion: v.schemaVersion, tables: v.tables });
    return v;
  }

  /** Restores a backup into a throw-away copy, runs migrations and checks it — the live database is untouched. */
  testRestore(file: string): VerifyResult {
    const full = this.resolveFile(file);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srmart-restore-test-'));
    const copy = path.join(tmpDir, 'restored.sqlite');
    try {
      fs.copyFileSync(full, copy, fs.constants.COPYFILE_EXCL);
      const db = openDatabase(copy, { migrate: false });
      runMigrations(db);
      db.close();
      const v = verifyDatabaseFile(copy);
      return { ...v, message: v.ok ? `Test restore succeeded on a separate copy (${v.tables.sales ?? 0} sales, ${v.tables.products ?? 0} products)` : v.message };
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  /** Path of a verified backup ready for restore. The caller must close the database before restoreFile(). */
  prepareRestore(file: string): string {
    const full = this.resolveFile(file);
    const v = this.testRestore(file);
    if (!v.ok) throw new AppError('DATABASE', `This backup cannot be restored: ${v.message}`);
    return full;
  }

  /**
   * Retention: deletes the oldest backups beyond `keep`, but never the newest verified backup and
   * never below `keep` files, so a new backup can't remove the only known-good copy.
   */
  prune(keep: number) {
    const all = this.list();
    const newestVerified = all.find((b) => b.verified);
    for (const b of all.slice(Math.max(keep, 1))) {
      if (b.file === newestVerified?.file) continue;
      if (b.reason.startsWith('pre-restore')) continue;
      fs.rmSync(b.path, { force: true });
      fs.rmSync(`${b.path}.json`, { force: true });
    }
  }
}

/**
 * Replaces the primary database file with a backup. The database must be CLOSED.
 * Copy to a temp file in the same folder → fsync → remove stale WAL/SHM → atomic rename.
 */
export function restoreFile(primaryPath: string, backupPath: string) {
  const tmp = `${primaryPath}.restore-tmp`;
  fs.rmSync(tmp, { force: true });
  fs.copyFileSync(backupPath, tmp);
  fsyncFile(tmp);
  for (const ext of ['-wal', '-shm']) fs.rmSync(`${primaryPath}${ext}`, { force: true });
  fs.renameSync(tmp, primaryPath);
}
