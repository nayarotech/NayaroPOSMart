import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {
  BackupService,
  ensureCertificate,
  ScannerServer,
  type ScanResult,
  createServices,
  ensureDemoUsers,
  MobileServer,
  openDatabase,
  pendingMigrations,
  restoreFile,
  runMigrations,
  seedDemoData,
  systemClock,
  type DB,
  type Services,
} from '@srmart/backend';
import { log } from './log';

/**
 * Owns the database connection and everything built on it, so restore can close and reopen
 * the database cleanly. All services run in the main process only — never in the renderer.
 */
export class AppState {
  db!: DB;
  services!: Services;
  backups: BackupService;
  mobile: MobileServer | null = null;
  scanner: ScannerServer | null = null;
  /** Number of POS screens currently listening for phone scans. */
  scanListeners = 0;
  /** Set by main.ts: pushes a scanned code to the renderer. */
  pushScan: (e: { code: string; device: string; at: string }) => void = () => undefined;
  readonly dbPath: string;

  constructor() {
    const override = process.env.SRMART_DATA_DIR;
    const dataDir = override ? path.resolve(override) : path.join(app.getPath('userData'), 'data');
    this.dbPath = path.join(dataDir, 'srmart.sqlite');
    this.backups = new BackupService(() => this.db, this.dbPath, () => this.backupDir());
  }

  backupDir(): string {
    const configured = this.services?.settings.get().backup.directory;
    if (configured) return configured;
    const base = process.env.SRMART_DATA_DIR ? path.join(path.resolve(process.env.SRMART_DATA_DIR), '..', 'srmart-backups') : path.join(app.getPath('documents'), 'Nayaro POS Backups');
    return base;
  }

  open() {
    const isNew = !fs.existsSync(this.dbPath);
    const db = openDatabase(this.dbPath, { migrate: false });
    this.db = db;
    this.services = createServices({ db, clock: systemClock });
    if (!isNew && pendingMigrations(db).length) {
      // Safety copy before changing the schema of an existing database.
      const b = this.backups.create('pre-migration');
      log.info(`pre-migration backup ${b.file}`);
    }
    const { applied } = runMigrations(db);
    if (applied.length) log.info(`migrations applied: ${applied.join(',')}`);
    if (isNew) {
      if (process.env.SRMART_NO_DEMO === '1') {
        // Production first-run: demo login accounts only, no demo products/sales; must change passwords.
        ensureDemoUsers(db);
        this.services.settings.repo.setDataMode('live');
        db.prepare('UPDATE users SET must_change_password = 1').run();
      } else {
        log.info('new database: seeding demo data');
        seedDemoData(db);
      }
    }
  }

  close() {
    if (this.db?.open) {
      try {
        this.db.pragma('wal_checkpoint(TRUNCATE)');
      } catch {
        /* ignore */
      }
      this.db.close();
    }
  }

  /** Restores a verified backup: safety backup of current data → close → atomic file swap → reopen + migrate. */
  restore(file: string): string {
    const source = this.backups.prepareRestore(file);
    this.mobile?.revokeAll();
    const safety = this.backups.create('pre-restore');
    this.close();
    try {
      restoreFile(this.dbPath, source);
    } finally {
      this.open();
    }
    return safety.file;
  }

  autoBackup(reason: string) {
    try {
      const s = this.services.settings.get().backup;
      const b = this.backups.create(reason);
      this.backups.prune(s.keep);
      log.info(`backup ${b.file}`);
      return b;
    } catch (err) {
      log.error(`auto backup failed: ${(err as Error).message}`);
      return null;
    }
  }

  mobileStaticDir() {
    return path.join(__dirname, 'mobile');
  }

  /** Starts/stops the HTTPS phone-scanner server to match Settings → Barcode scanners. */
  async syncScannerServer() {
    const cfg = this.services.settings.get().scanner;
    if (this.scanner && (!cfg.phoneEnabled || this.scanner.port !== cfg.phonePort)) {
      await this.scanner.stop();
      this.scanner = null;
    }
    if (cfg.phoneEnabled && !this.scanner) {
      const tls = await ensureCertificate(path.join(app.getPath('userData'), 'certs'));
      const server = new ScannerServer({
        port: cfg.phonePort,
        tls,
        staticDir: this.mobileStaticDir(),
        storeName: () => this.services.settings.get().store.name,
        onScan: (code, device): ScanResult => {
          const product = this.services.products.lookupBarcode(code);
          const delivered = this.scanListeners > 0;
          if (delivered) this.pushScan({ code, device: device.name, at: new Date().toISOString() });
          return {
            ok: !!product,
            product: product ? { name: product.name, pricePaisa: product.pricePaisa } : null,
            delivered,
            message: !delivered ? 'Received, but the POS checkout screen is not open' : product ? 'Added to the POS cart' : 'Unknown barcode — not in the product list',
          };
        },
      });
      await server.start();
      this.scanner = server;
      log.info(`phone scanner server on https port ${cfg.phonePort}`);
    }
  }

  async syncMobileServer() {
    const cfg = this.services.settings.get().mobile;
    if (this.mobile && (!cfg.enabled || this.mobile.port !== cfg.port)) {
      await this.mobile.stop();
      this.mobile = null;
    }
    if (cfg.enabled && !this.mobile) {
      const tls = await ensureCertificate(path.join(app.getPath('userData'), 'certs'));
      const server = new MobileServer({ services: () => this.services, staticDir: this.mobileStaticDir(), port: cfg.port, tls });
      try {
        await server.start();
        this.mobile = server;
        log.info(`mobile admin server on port ${cfg.port}`);
      } catch (err) {
        log.error(`mobile server failed to start: ${(err as Error).message}`);
        throw err;
      }
    }
  }
}
