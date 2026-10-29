import type { AppSettings, SessionUser } from '@srmart/shared';
import { settingsSchema } from '@srmart/shared';
import type { Ctx } from '../context';
import { tx } from '../db/database';
import { invalid } from '../errors';
import { AuditRepo } from '../repositories/auditRepo';
import { SettingsRepo } from '../repositories/settingsRepo';
import { requireRole } from './auth';

export class SettingsService {
  readonly repo: SettingsRepo;
  private audit: AuditRepo;

  constructor(private ctx: Ctx) {
    this.repo = new SettingsRepo(ctx);
    this.audit = new AuditRepo(ctx);
  }

  get(): AppSettings {
    return this.repo.getSettings();
  }

  update(user: SessionUser, input: unknown): AppSettings {
    requireRole(user, 'admin');
    const s = settingsSchema.parse(input);
    // Compliance gate: tax can only be switched on after an admin records how it was verified.
    if (s.tax.enabled) {
      if (!s.tax.verified) throw invalid('Tax cannot be enabled until it is marked as verified with IRD or a qualified tax adviser', { 'tax.enabled': 'Verify first' });
      if (s.tax.verificationNote.trim().length < 10) throw invalid('Record who verified the tax configuration and when (verification note)', { 'tax.verificationNote': 'Required' });
      if (!s.tax.label.trim() || s.tax.rateBp <= 0) throw invalid('Enter the verified tax label and rate', { 'tax.rateBp': 'Required' });
    }
    if (!s.paymentMethods.some((m) => m.enabled)) throw invalid('At least one payment method must be enabled');
    if (!s.paymentMethods.some((m) => m.code === 'cash')) throw invalid('The cash payment method cannot be removed');
    return tx(this.ctx.db, () => {
      const before = this.repo.getSettings();
      this.repo.saveSettings(s);
      const changed = Object.keys(s).filter((k) => JSON.stringify((s as Record<string, unknown>)[k]) !== JSON.stringify((before as Record<string, unknown>)[k]));
      this.audit.log({ action: 'settings.updated', entityType: 'settings', userId: user.id, details: { sections: changed } });
      if (JSON.stringify(before.tax) !== JSON.stringify(s.tax)) {
        this.audit.log({ action: 'settings.tax_changed', entityType: 'settings', userId: user.id, details: { before: before.tax, after: s.tax } });
      }
      return s;
    });
  }
}
