import type { FiscalYearInfo } from './fiscal';

export type Role = 'admin' | 'cashier';
export type Symbology = 'EAN13' | 'EAN8' | 'UPCA' | 'CODE128' | 'OTHER';

export interface SessionUser {
  id: number;
  username: string;
  fullName: string;
  role: Role;
  mustChangePassword: boolean;
}

export interface Page<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface Category {
  id: number;
  name: string;
  productCount: number;
}

export interface ProductBarcode {
  id: number;
  productId: number;
  code: string;
  symbology: Symbology;
  source: 'manufacturer' | 'internal';
  isPrimary: boolean;
  createdAt: string;
}

export interface Product {
  id: number;
  sku: string;
  name: string;
  categoryId: number | null;
  categoryName: string | null;
  brand: string | null;
  unit: string;
  costPaisa: number;
  pricePaisa: number;
  qtyOnHand: number;
  minStock: number;
  trackExpiry: boolean;
  active: boolean;
  isDemo: boolean;
  priceChangedAt: string | null;
  labelPrintedAt: string | null;
  /** True when the price changed after the last label print. */
  labelOutdated: boolean;
  createdAt: string;
  updatedAt: string;
  barcodes: ProductBarcode[];
}

export interface PriceHistoryEntry {
  id: number;
  pricePaisa: number;
  costPaisa: number;
  effectiveFrom: string;
  changedBy: string | null;
  reason: string | null;
}

export interface ImportRowResult {
  row: number;
  status: 'ok' | 'duplicate' | 'error';
  name: string;
  message: string;
}

export interface ImportReport {
  committed: boolean;
  total: number;
  ok: number;
  duplicates: number;
  errors: number;
  rows: ImportRowResult[];
}

export interface QuoteLine {
  productId: number;
  sku: string;
  name: string;
  unit: string;
  quantity: number;
  unitPricePaisa: number;
  lineSubtotalPaisa: number;
  discountPaisa: number;
  lineTotalPaisa: number;
  qtyAvailable: number;
  /** Automatic festival/promotion discount on this line (not counted toward the cashier limit). */
  promoDiscountPaisa: number;
  promotionId: number | null;
  promotionName: string | null;
}

export interface SaleQuote {
  lines: QuoteLine[];
  subtotalPaisa: number;
  lineDiscountPaisa: number;
  orderDiscountPaisa: number;
  discountPaisa: number;
  taxablePaisa: number;
  taxPaisa: number;
  totalPaisa: number;
  tax: { enabled: boolean; label: string; rateBp: number; inclusive: boolean };
  discountRequiresApproval: boolean;
  warnings: string[];
  promoDiscountPaisa: number;
  /** Lucky-draw schemes this bill qualifies for, with the number of coupons it would earn. */
  qualifyingSchemes: { id: number; name: string; minBillPaisa: number; coupons: number }[];
  /** Active schemes the bill does not reach yet (to tell the customer how much more to buy). */
  nearSchemes: { id: number; name: string; minBillPaisa: number; shortByPaisa: number }[];
}

export type SaleStatus = 'completed' | 'voided' | 'partially_returned' | 'returned';

export interface SaleSummary {
  id: number;
  receiptNo: string;
  fiscalYear: string;
  businessDate: string;
  createdAt: string;
  cashierName: string;
  itemCount: number;
  totalPaisa: number;
  refundedPaisa: number;
  status: SaleStatus;
  paymentMethod: string;
  isDemo: boolean;
}

export interface SaleItem {
  id: number;
  productId: number;
  sku: string;
  name: string;
  unit: string;
  quantity: number;
  returnedQuantity: number;
  unitPricePaisa: number;
  unitCostPaisa: number;
  discountPaisa: number;
  lineTotalPaisa: number;
  promoDiscountPaisa: number;
  promotionName: string | null;
}

export interface Payment {
  id: number;
  method: string;
  kind: 'payment' | 'refund';
  amountPaisa: number;
  tenderedPaisa: number | null;
  changePaisa: number | null;
  reference: string | null;
  createdAt: string;
}

export interface SaleReturn {
  id: number;
  returnNo: string;
  reason: string;
  restock: boolean;
  refundPaisa: number;
  createdAt: string;
  createdBy: string;
  approvedBy: string | null;
  items: { saleItemId: number; name: string; quantity: number; refundPaisa: number }[];
}

export interface SaleDetail extends SaleSummary {
  subtotalPaisa: number;
  discountPaisa: number;
  taxPaisa: number;
  taxLabel: string | null;
  taxRateBp: number;
  taxInclusive: boolean;
  customerName: string | null;
  bsDate: string;
  items: SaleItem[];
  payments: Payment[];
  returns: SaleReturn[];
  voidReason: string | null;
  voidedAt: string | null;
  voidedBy: string | null;
  discountApprovedBy: string | null;
  promoDiscountPaisa: number;
  customer: { id: number; name: string; phone: string } | null;
  coupons: { couponNo: string; schemeName: string; eligible: boolean }[];
}

export interface Supplier {
  id: number;
  name: string;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  panVat: string | null;
  notes: string | null;
  isDemo: boolean;
  purchaseCount: number;
}

export interface PurchaseSummary {
  id: number;
  purchaseNo: string;
  supplierId: number;
  supplierName: string;
  invoiceNo: string;
  invoiceDate: string;
  fiscalYear: string;
  totalPaisa: number;
  itemCount: number;
  receivedAt: string;
  receivedBy: string;
  isDemo: boolean;
}

export interface PurchaseDetail extends PurchaseSummary {
  notes: string | null;
  items: { id: number; productId: number; sku: string; name: string; quantity: number; unitCostPaisa: number; lineTotalPaisa: number; batchNo: string | null; expiryDate: string | null }[];
}

export type MovementType = 'opening' | 'sale' | 'purchase' | 'return' | 'void' | 'adjustment';

export interface StockMovement {
  id: number;
  productId: number;
  sku: string;
  productName: string;
  type: MovementType;
  quantityDelta: number;
  balanceAfter: number;
  reason: string | null;
  refType: string | null;
  refId: number | null;
  refLabel: string | null;
  userName: string | null;
  createdAt: string;
}

export interface Batch {
  id: number;
  productId: number;
  productName: string;
  sku: string;
  batchNo: string | null;
  expiryDate: string | null;
  qtyReceived: number;
  qtyRemaining: number;
  daysToExpiry: number | null;
}

export interface UserRow {
  id: number;
  username: string;
  fullName: string;
  role: Role;
  active: boolean;
  isDemo: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface AuditEntry {
  id: number;
  action: string;
  entityType: string;
  entityId: string | null;
  userName: string | null;
  approvedByName: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
}

export interface FiscalYearRow {
  code: string;
  startDate: string;
  endDate: string;
  source: 'computed' | 'manual';
  saleCount: number;
  isCurrent: boolean;
}

export interface FiscalContext extends FiscalYearInfo {
  dayNumber: number;
  totalDays: number;
  daysLeft: number;
  percent: number;
  todayAd: string;
  todayBs: string;
  todayBsLong: string;
}

export interface AppInfo {
  version: string;
  dataMode: 'demo' | 'live';
  storeName: string;
  fiscal: FiscalContext;
  demoCredentialsActive: boolean;
  dbPath: string;
  lastBackupAt: string | null;
}

export interface SalesTotals {
  salesCount: number;
  grossSalesPaisa: number;
  discountPaisa: number;
  taxPaisa: number;
  netSalesPaisa: number;
  refundsPaisa: number;
  costOfGoodsPaisa: number;
  estimatedMarginPaisa: number;
  estimatedMarginBp: number;
}

export interface DashboardSummary {
  fiscal: FiscalContext;
  dataMode: 'demo' | 'live';
  today: SalesTotals & { demoSalesCount: number; realSalesCount: number };
  fiscalYearToDate: SalesTotals;
  last7Days: { date: string; netSalesPaisa: number; salesCount: number }[];
  lowStock: Product[];
  lowStockCount: number;
  recent: SaleSummary[];
  outdatedLabelCount: number;
  expiringSoonCount: number;
}

export interface SalesReport {
  from: string;
  to: string;
  groupBy: 'day' | 'week' | 'month';
  totals: SalesTotals;
  buckets: ({ key: string; label: string } & SalesTotals)[];
  payments: { method: string; kind: 'payment' | 'refund'; count: number; amountPaisa: number }[];
  topProducts: { productId: number; name: string; quantity: number; netPaisa: number; estimatedMarginPaisa: number }[];
  byCategory: { category: string; netPaisa: number; quantity: number }[];
  promotions: { name: string; lines: number; discountPaisa: number }[];
}

export interface StockValuation {
  products: number;
  units: number;
  costValuePaisa: number;
  retailValuePaisa: number;
  byCategory: { category: string; units: number; costValuePaisa: number; retailValuePaisa: number }[];
}

export interface PurchaseReport {
  from: string;
  to: string;
  count: number;
  totalPaisa: number;
  bySupplier: { supplier: string; count: number; totalPaisa: number }[];
}

export interface ReturnsReport {
  from: string;
  to: string;
  count: number;
  refundPaisa: number;
  voidCount: number;
  voidPaisa: number;
  rows: { returnNo: string; receiptNo: string; reason: string; refundPaisa: number; createdAt: string; createdBy: string }[];
}

export interface PrinterInfo {
  name: string;
  displayName: string;
  isDefault: boolean;
  status: number;
}

export interface PrintResult {
  ok: boolean;
  mode: 'printed' | 'dialog' | 'pdf' | 'cancelled';
  message: string;
  pdfPath?: string;
}

export interface BackupInfo {
  file: string;
  path: string;
  sizeBytes: number;
  createdAt: string;
  reason: string;
  verified: boolean | null;
}

export interface BackupStatus {
  directory: string;
  primaryDbPath: string;
  sameDriveWarning: boolean;
  backups: BackupInfo[];
  lastBackupAt: string | null;
}

export interface VerifyResult {
  ok: boolean;
  integrity: string;
  tables: Record<string, number>;
  schemaVersion: number;
  message: string;
}

export interface MobileStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  urls: string[];
  message: string;
}

export interface Promotion {
  id: number;
  name: string;
  percentBp: number;
  categoryId: number | null;
  categoryName: string | null;
  startsOn: string;
  endsOn: string;
  active: boolean;
  /** 'running' | 'scheduled' | 'ended' | 'inactive' relative to today */
  state: 'running' | 'scheduled' | 'ended' | 'inactive';
  isDemo: boolean;
  timesApplied: number;
  discountGivenPaisa: number;
}

export interface Scheme {
  id: number;
  name: string;
  description: string;
  minBillPaisa: number;
  entryStepPaisa: number | null;
  startsOn: string;
  endsOn: string;
  couponPrefix: string;
  active: boolean;
  state: 'running' | 'scheduled' | 'ended' | 'inactive';
  isDemo: boolean;
  couponCount: number;
  eligibleCouponCount: number;
  customerCount: number;
  winnerCount: number;
}

export interface SchemeCoupon {
  id: number;
  couponNo: string;
  saleId: number;
  receiptNo: string;
  billTotalPaisa: number;
  customerName: string;
  customerPhone: string;
  createdAt: string;
  eligible: boolean;
}

export interface SchemeWinner {
  id: number;
  rank: number;
  prize: string;
  couponNo: string;
  receiptNo: string;
  customerName: string;
  customerPhone: string;
  drawnAt: string;
  drawnBy: string;
  poolSize: number;
}

export interface SchemeDetail extends Scheme {
  coupons: SchemeCoupon[];
  winners: SchemeWinner[];
}

export interface Customer {
  id: number;
  name: string;
  phone: string;
  consentAt: string | null;
  isDemo: boolean;
  saleCount: number;
  totalSpentPaisa: number;
  couponCount: number;
  lastPurchaseAt: string | null;
}

export interface ScannerDevice {
  id: string;
  name: string;
  pairedAt: string;
  lastSeenAt: string;
  scans: number;
}

export interface ScannerStatus {
  usbEnabled: boolean;
  phoneEnabled: boolean;
  running: boolean;
  port: number;
  urls: string[];
  message: string;
  devices: ScannerDevice[];
  /** Present while a pairing QR code is active. */
  pairing: { url: string; qrSvg: string; expiresAt: string } | null;
}

/** Pushed from main to the POS screen when a paired phone scans a code. */
export interface ScannerEvent {
  code: string;
  device: string;
  at: string;
}
