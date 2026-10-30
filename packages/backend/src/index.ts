export * from './errors';
export * from './clock';
export type { Ctx } from './context';
export { openDatabase, tx, type DB } from './db/database';
export { runMigrations, pendingMigrations, currentSchemaVersion, LATEST_SCHEMA_VERSION, MIGRATIONS } from './db/migrations';
export { createServices, type Services } from './services';
export { requireRole, hashPassword, verifyPassword } from './services/auth';
export { BackupService, restoreFile, verifyDatabaseFile } from './services/backup';
export { CONFIRM_DELETE_REAL, CONFIRM_GO_LIVE, CONFIRM_RESET_DEMO } from './services/demo';
export { DEFAULT_SETTINGS } from './repositories/settingsRepo';
export { seedDemoData, ensureDemoUsers, DEMO_USERS } from './seed/demo';
export { renderLabelsHtml } from './render/labels';
export { renderReceiptHtml } from './render/receipt';
export { MobileServer, lanUrls } from './api/mobileServer';
export { ScannerServer, qrSvg, type ScanResult } from './api/scannerServer';
export { ensureCertificate } from './api/tls';
export { maskPhone } from './render/receipt';

export { renderShiftHtml } from './render/shift';
