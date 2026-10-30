import type { SessionUser } from '@srmart/shared';
import type { Ctx } from '../context';
import { tx } from '../db/database';
import { AppError, invalid } from '../errors';
import { AuditRepo } from '../repositories/auditRepo';
import { SettingsRepo } from '../repositories/settingsRepo';
import { seedDemoData } from '../seed/demo';
import { AuthService, requireRole } from './auth';

const OPERATIONAL_TABLES = [
  'checkout_carts', 'cash_movements',
  'scheme_winners', 'scheme_entries',
  'sale_batch_allocations', 'sales_return_items', 'payments', 'sales_returns', 'sale_items', 'sales', 'cash_shifts',
  'promotions', 'schemes', 'customers',
  'product_batches', 'stock_movements', 'purchase_items', 'purchases',
  'product_prices', 'product_barcodes', 'products', 'categories', 'suppliers',
  'receipt_sequences', 'id_sequences', 'sync_outbox',
];

export const CONFIRM_RESET_DEMO = 'RESET DEMO';
export const CONFIRM_DELETE_REAL = 'DELETE REAL DATA';
export const CONFIRM_GO_LIVE = 'START LIVE';

export class DemoService {
  private settings: SettingsRepo;
  private audit: AuditRepo;

  constructor(private ctx: Ctx, private auth: AuthService) {
    this.settings = new SettingsRepo(ctx);
    this.audit = new AuditRepo(ctx);
  }

  realRecordCount(): number {
    const q = (t: string) => (this.ctx.db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE is_demo = 0`).get() as { n: number }).n;
    return q('sales') + q('purchases') + q('products') + q('suppliers');
  }

  private wipe() {
    // The marker row unlocks the append-only triggers for this transaction only.
    this.settings.setRaw('__wipe_authorized', '1');
    for (const t of OPERATIONAL_TABLES) this.ctx.db.prepare(`DELETE FROM ${t}`).run();
    this.settings.delete('__wipe_authorized');
  }

  /** Validates the request; the caller (desktop) must take a backup BEFORE calling apply*. */
  checkReset(user: SessionUser, confirmText: string, password: string) {
    requireRole(user, 'admin');
    this.auth.verify({ username: user.username, password }, { audit: 'demo.reset' });
    const real = this.realRecordCount();
    const required = real > 0 ? CONFIRM_DELETE_REAL : CONFIRM_RESET_DEMO;
    if (confirmText !== required) {
      throw invalid(real > 0 ? `There are ${real} real (non-demo) records. Type "${CONFIRM_DELETE_REAL}" to erase them and reload demo data.` : `Type "${CONFIRM_RESET_DEMO}" to confirm`);
    }
    return { real };
  }

  applyReset(user: SessionUser, backupFile: string) {
    const real = this.realRecordCount();
    tx(this.ctx.db, () => {
      this.wipe();
      this.audit.log({ action: 'demo.reset', entityType: 'system', userId: user.id, details: { realRecordsDeleted: real, backupFile } });
    });
    seedDemoData(this.ctx.db, this.ctx.clock.now());
  }

  checkGoLive(user: SessionUser, confirmText: string, password: string) {
    requireRole(user, 'admin');
    this.auth.verify({ username: user.username, password }, { audit: 'demo.go_live' });
    if (this.settings.getDataMode() === 'live') throw new AppError('CONFLICT', 'The system is already in live mode');
    if (confirmText !== CONFIRM_GO_LIVE) throw invalid(`Type "${CONFIRM_GO_LIVE}" to confirm`);
  }

  /** Removes all demo records and switches to live mode. Users, settings and audit history are kept. */
  applyGoLive(user: SessionUser, backupFile: string) {
    tx(this.ctx.db, () => {
      this.wipe();
      this.settings.setDataMode('live');
      this.ctx.db.prepare('UPDATE users SET must_change_password = 1 WHERE default_password = 1').run();
      this.audit.log({ action: 'demo.go_live', entityType: 'system', userId: user.id, details: { backupFile } });
    });
  }
}
