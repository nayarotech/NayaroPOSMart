import type * as S from './schemas';
import type * as T from './types';

type Empty = Record<string, never> | undefined;

/**
 * The complete IPC surface between renderer and main.
 * Every channel is validated in the main process; renderer input is never trusted.
 */
export interface ApiMap {
  'auth.login': { in: S.Credentials; out: T.SessionUser };
  'auth.logout': { in: Empty; out: { ok: true } };
  'auth.session': { in: Empty; out: T.SessionUser | null };
  'auth.changePassword': { in: { currentPassword: string; newPassword: string }; out: { ok: true } };

  'app.info': { in: Empty; out: T.AppInfo };
  'dashboard.summary': { in: Empty; out: T.DashboardSummary };

  'categories.list': { in: Empty; out: T.Category[] };
  'categories.create': { in: { name: string }; out: T.Category };

  'products.list': { in: S.ProductQuery; out: T.Page<T.Product> };
  'products.get': { in: { id: number }; out: T.Product & { priceHistory: T.PriceHistoryEntry[] } };
  'products.create': { in: S.ProductInput; out: T.Product };
  'products.update': { in: S.ProductUpdate; out: T.Product };
  'products.setActive': { in: { id: number; active: boolean }; out: T.Product };
  'products.lookupBarcode': { in: { code: string }; out: T.Product | null };
  'products.search': { in: { q: string; limit?: number }; out: T.Product[] };
  'products.importCsv': { in: { csv: string; commit: boolean }; out: T.ImportReport };
  'products.exportCsv': { in: Empty; out: { saved: boolean; path: string | null; count: number } };

  'barcodes.add': { in: { productId: number; code: string; symbology?: T.Symbology }; out: T.ProductBarcode };
  'barcodes.generateInternal': { in: { productId: number }; out: T.ProductBarcode };
  'barcodes.remove': { in: { barcodeId: number }; out: { ok: true } };
  'barcodes.setPrimary': { in: { barcodeId: number }; out: { ok: true } };

  'labels.render': { in: S.LabelJob; out: { html: string; labelCount: number; warnings: string[] } };
  'labels.print': { in: S.LabelJob & { mode: 'dialog' | 'pdf' | 'silent' }; out: T.PrintResult };
  'printers.list': { in: Empty; out: T.PrinterInfo[] };

  'sales.quote': { in: S.SaleQuoteInput; out: T.SaleQuote };
  'sales.complete': { in: S.CompleteSaleInput; out: T.SaleDetail };
  'sales.list': { in: S.SalesQuery; out: T.Page<T.SaleSummary> };
  'sales.get': { in: { id: number }; out: T.SaleDetail };
  'sales.void': { in: S.VoidSaleInput; out: T.SaleDetail };
  'sales.return': { in: S.ReturnInput; out: T.SaleDetail };
  'receipts.render': { in: { saleId: number }; out: { html: string } };
  'receipts.print': { in: { saleId: number; mode: 'dialog' | 'pdf' | 'silent' }; out: T.PrintResult };

  'suppliers.list': { in: Empty; out: T.Supplier[] };
  'suppliers.create': { in: S.SupplierInput; out: T.Supplier };
  'suppliers.update': { in: S.SupplierInput & { id: number }; out: T.Supplier };

  'purchases.list': { in: { page?: number; pageSize?: number; fiscalYear?: string }; out: T.Page<T.PurchaseSummary> };
  'purchases.get': { in: { id: number }; out: T.PurchaseDetail };
  'purchases.create': { in: S.PurchaseInput; out: T.PurchaseDetail };

  'inventory.movements': { in: { productId?: number; type?: T.MovementType; page?: number; pageSize?: number }; out: T.Page<T.StockMovement> };
  'inventory.adjust': { in: S.AdjustmentInput; out: T.StockMovement };
  'inventory.lowStock': { in: Empty; out: T.Product[] };
  'inventory.expiring': { in: { days: number }; out: T.Batch[] };

  'reports.sales': { in: { from: string; to: string; groupBy?: 'day' | 'week' | 'month' }; out: T.SalesReport };
  'reports.stockValuation': { in: Empty; out: T.StockValuation };
  'reports.purchases': { in: { from: string; to: string }; out: T.PurchaseReport };
  'reports.returns': { in: { from: string; to: string }; out: T.ReturnsReport };
  'reports.fiscalYears': { in: Empty; out: T.FiscalYearRow[] };

  'users.list': { in: Empty; out: T.UserRow[] };
  'users.create': { in: S.UserInput; out: T.UserRow };
  'users.update': { in: S.UserUpdate; out: T.UserRow };
  'users.resetPassword': { in: { id: number; newPassword: string }; out: { ok: true } };
  'audit.list': { in: { page?: number; pageSize?: number; action?: string }; out: T.Page<T.AuditEntry> };

  'settings.get': { in: Empty; out: S.AppSettings };
  'settings.update': { in: S.AppSettings; out: S.AppSettings };

  'backup.status': { in: Empty; out: T.BackupStatus };
  'backup.create': { in: Empty; out: T.BackupInfo };
  'backup.verify': { in: { file: string }; out: T.VerifyResult };
  'backup.testRestore': { in: { file: string }; out: T.VerifyResult };
  'backup.restore': { in: { file: string; password: string }; out: { ok: true; safetyBackup: string } };
  'backup.chooseDirectory': { in: Empty; out: { directory: string | null } };
  'backup.openFolder': { in: Empty; out: { ok: true } };

  'demo.reset': { in: { confirmText: string; password: string }; out: { ok: true; backup: string } };
  'demo.goLive': { in: { confirmText: string; password: string }; out: { ok: true; backup: string } };

  'mobile.status': { in: Empty; out: T.MobileStatus };

  'promotions.list': { in: Empty; out: T.Promotion[] };
  'promotions.create': { in: S.PromotionInput; out: T.Promotion };
  'promotions.update': { in: S.PromotionInput & { id: number }; out: T.Promotion };
  'schemes.list': { in: Empty; out: T.Scheme[] };
  'schemes.get': { in: { id: number }; out: T.SchemeDetail };
  'schemes.create': { in: S.SchemeInput; out: T.Scheme };
  'schemes.update': { in: S.SchemeInput & { id: number }; out: T.Scheme };
  'schemes.draw': { in: S.DrawInput; out: T.SchemeWinner[] };
  'customers.list': { in: { q?: string; page?: number; pageSize?: number }; out: T.Page<T.Customer> };
  'customers.lookup': { in: { phone: string }; out: T.Customer | null };

  'scanner.status': { in: Empty; out: T.ScannerStatus };
  'scanner.startPairing': { in: Empty; out: T.ScannerStatus };
  'scanner.unpair': { in: { deviceId: string }; out: T.ScannerStatus };
}

export type ApiChannel = keyof ApiMap;
export type ApiIn<K extends ApiChannel> = ApiMap[K]['in'];
export type ApiOut<K extends ApiChannel> = ApiMap[K]['out'];

export type ApiEnvelope<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string; fields?: Record<string, string> } };

/** Allow-list used by the preload script; anything else is rejected before it reaches main. */
export const API_CHANNELS = [
  'auth.login', 'auth.logout', 'auth.session', 'auth.changePassword',
  'app.info', 'dashboard.summary',
  'categories.list', 'categories.create',
  'products.list', 'products.get', 'products.create', 'products.update', 'products.setActive',
  'products.lookupBarcode', 'products.search', 'products.importCsv', 'products.exportCsv',
  'barcodes.add', 'barcodes.generateInternal', 'barcodes.remove', 'barcodes.setPrimary',
  'labels.render', 'labels.print', 'printers.list',
  'sales.quote', 'sales.complete', 'sales.list', 'sales.get', 'sales.void', 'sales.return',
  'receipts.render', 'receipts.print',
  'suppliers.list', 'suppliers.create', 'suppliers.update',
  'purchases.list', 'purchases.get', 'purchases.create',
  'inventory.movements', 'inventory.adjust', 'inventory.lowStock', 'inventory.expiring',
  'reports.sales', 'reports.stockValuation', 'reports.purchases', 'reports.returns', 'reports.fiscalYears',
  'users.list', 'users.create', 'users.update', 'users.resetPassword', 'audit.list',
  'settings.get', 'settings.update',
  'backup.status', 'backup.create', 'backup.verify', 'backup.testRestore', 'backup.restore', 'backup.chooseDirectory', 'backup.openFolder',
  'demo.reset', 'demo.goLive',
  'mobile.status',
  'promotions.list', 'promotions.create', 'promotions.update',
  'schemes.list', 'schemes.get', 'schemes.create', 'schemes.update', 'schemes.draw',
  'customers.list', 'customers.lookup',
  'scanner.status', 'scanner.startPairing', 'scanner.unpair',
] as const satisfies readonly ApiChannel[];

// Compile-time guarantee that the allow-list covers every channel.
type Missing = Exclude<ApiChannel, (typeof API_CHANNELS)[number]>;
const _exhaustive: Missing extends never ? true : Missing = true;
void _exhaustive;

/** Shape of window.srmart exposed by the preload script. */
export interface SrMartBridge {
  invoke<K extends ApiChannel>(channel: K, payload?: ApiIn<K>): Promise<ApiOut<K>>;
  /** Subscribe to codes scanned by a paired phone. Returns an unsubscribe function. */
  onScannerCode(cb: (e: T.ScannerEvent) => void): () => void;
  platform: string;
}

/** Read-only endpoints served to the admin mobile app over the LAN. */
export interface MobileSummary {
  storeName: string;
  dataMode: 'demo' | 'live';
  generatedAt: string;
  fiscal: T.FiscalContext;
  today: T.SalesTotals;
  fiscalYearToDate: T.SalesTotals;
  last7Days: { date: string; netSalesPaisa: number; salesCount: number }[];
  lowStock: { id: number; sku: string; name: string; qtyOnHand: number; minStock: number; unit: string }[];
  recent: T.SaleSummary[];
}
