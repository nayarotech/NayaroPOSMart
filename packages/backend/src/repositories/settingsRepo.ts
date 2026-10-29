import type { AppSettings } from '@srmart/shared';
import type { Ctx } from '../context';

export const DEFAULT_SETTINGS: AppSettings = {
  store: {
    name: 'Nayaro Mart',
    tagline: 'Groceries · Cosmetics · Clothing · Household',
    address: '',
    phone: '',
    email: '',
    panVat: '',
  },
  receipt: {
    header: 'Thank you for shopping with us',
    footer: 'Please check your items before leaving the counter.',
    showBsDate: true,
    paperWidthMm: 80,
    prefix: 'NYM',
  },
  currency: { code: 'NPR', symbol: 'Rs.' },
  paymentMethods: [
    { code: 'cash', label: 'Cash', enabled: true, requiresReference: false },
    { code: 'qr', label: 'QR / Wallet (record only)', enabled: false, requiresReference: true },
    { code: 'card', label: 'Card terminal (record only)', enabled: false, requiresReference: true },
  ],
  tax: { enabled: false, verified: false, verificationNote: '', label: '', rateBp: 0, inclusive: false },
  printers: { receiptPrinter: null, labelPrinter: null, silentReceipt: false, autoPrintReceipt: false },
  labels: {
    sticker: { widthMm: 50, heightMm: 30, marginMm: 2, gapMm: 2, columns: 1, pageWidthMm: 50 },
    shelf: { widthMm: 70, heightMm: 38, marginMm: 3, gapMm: 3, columns: 2, pageWidthMm: 210 },
  },
  pos: { scanDebounceMs: 350, cashierMaxDiscountBp: 500, allowNegativeStock: false },
  mobile: { enabled: false, port: 8787 },
  scanner: { usbEnabled: true, phoneEnabled: false, phonePort: 8788 },
  backup: { directory: null, autoBackupOnExit: true, keep: 30 },
};

export type DataMode = 'demo' | 'live';

export class SettingsRepo {
  constructor(private ctx: Ctx) {}

  getRaw(key: string): string | null {
    const row = this.ctx.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setRaw(key: string, value: string) {
    this.ctx.db
      .prepare(
        `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, this.ctx.clock.now().toISOString());
  }

  delete(key: string) {
    this.ctx.db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
  }

  getSettings(): AppSettings {
    const raw = this.getRaw('settings');
    if (!raw) return structuredClone(DEFAULT_SETTINGS);
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    // Shallow-merge each section so new settings added in later versions get defaults.
    const merged = structuredClone(DEFAULT_SETTINGS) as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(parsed)) {
      const base = merged[k];
      merged[k] = base && typeof base === 'object' && !Array.isArray(base) && v && typeof v === 'object' && !Array.isArray(v) ? { ...base, ...v } : v;
    }
    return merged as unknown as AppSettings;
  }

  saveSettings(s: AppSettings) {
    this.setRaw('settings', JSON.stringify(s));
  }

  getDataMode(): DataMode {
    return (this.getRaw('data_mode') as DataMode | null) ?? 'live';
  }

  setDataMode(mode: DataMode) {
    this.setRaw('data_mode', mode);
  }

  isDemo(): number {
    return this.getDataMode() === 'demo' ? 1 : 0;
  }
}
