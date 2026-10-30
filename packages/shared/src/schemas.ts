import { z } from 'zod';

const id = z.number().int().positive();
const paisa = z.number().int().min(0).max(10_000_000_000); // up to Rs 10 crore
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const optionalText = (max: number) =>
  z.string().trim().max(max).optional().nullable().transform((v) => (v ? v : null));

/** Phone numbers: digits only after removing spaces/dashes, optional leading +, 7–15 digits. */
export const phoneSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, ''))
  .pipe(z.string().regex(/^\+?\d{7,15}$/, 'Enter a valid phone number (7–15 digits)'));

export const credentialsSchema = z.object({
  username: z.string().trim().min(1, 'Username is required').max(50),
  password: z.string().min(1, 'Password is required').max(200),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(8, 'Password must be at least 8 characters').max(200),
});

export const SYMBOLOGIES = ['EAN13', 'EAN8', 'UPCA', 'CODE128', 'OTHER'] as const;
export const symbologySchema = z.enum(SYMBOLOGIES);

/** Barcode values: printable ASCII, no spaces, 3–48 chars (what HID scanners emit). */
export const barcodeValueSchema = z
  .string()
  .trim()
  .min(3, 'Barcode is too short')
  .max(48, 'Barcode is too long')
  .regex(/^[\x21-\x7E]+$/, 'Barcode may only contain printable characters without spaces');

export const productInputSchema = z
  .object({
    name: z.string().trim().min(2, 'Name must be at least 2 characters').max(120),
    categoryId: id.nullable(),
    brand: optionalText(80),
    unit: z.string().trim().min(1).max(20).default('pcs'),
    costPaisa: paisa,
    pricePaisa: paisa.refine((v) => v > 0, 'Selling price must be greater than zero'),
    minStock: z.number().int().min(0).max(1_000_000),
    trackExpiry: z.boolean().default(false),
    active: z.boolean().default(true),
    /** Opening stock only on create; recorded as an "opening" stock movement. */
    openingQty: z.number().int().min(0).max(1_000_000).optional(),
    /** Optional manufacturer barcode registered on create. */
    barcode: barcodeValueSchema.optional().nullable(),
    barcodeSymbology: symbologySchema.optional(),
    /** Generate an internal Code 128 barcode on create when no manufacturer barcode is given. */
    generateInternalBarcode: z.boolean().optional(),
  })
  .refine((p) => p.costPaisa <= p.pricePaisa * 10, { message: 'Cost price looks wrong (more than 10x selling price)', path: ['costPaisa'] });

export const productUpdateSchema = z.object({
  id,
  name: z.string().trim().min(2).max(120),
  categoryId: id.nullable(),
  brand: optionalText(80),
  unit: z.string().trim().min(1).max(20),
  costPaisa: paisa,
  pricePaisa: paisa.refine((v) => v > 0, 'Selling price must be greater than zero'),
  minStock: z.number().int().min(0).max(1_000_000),
  trackExpiry: z.boolean(),
  priceChangeReason: optionalText(200),
});

export const productQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  categoryId: id.optional().nullable(),
  status: z.enum(['active', 'inactive', 'all']).default('active'),
  stock: z.enum(['all', 'low', 'out']).default('all'),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(5).max(200).default(25),
});

export const cartLineSchema = z.object({
  productId: id,
  quantity: z.number().int().min(1, 'Quantity must be at least 1').max(10_000),
  discountPaisa: paisa.default(0),
});

export const saleQuoteSchema = z.object({
  lines: z.array(cartLineSchema).min(1, 'Cart is empty').max(300),
  orderDiscountPaisa: paisa.default(0),
});

export const overrideSchema = credentialsSchema.optional().nullable();

export const completeSaleSchema = saleQuoteSchema.extend({
  clientTxnId: z.string().uuid(),
  expectedTotalPaisa: paisa,
  payment: z.object({
    method: z.string().trim().min(1).max(30),
    tenderedPaisa: paisa,
    reference: optionalText(60),
  }),
  override: overrideSchema,
  customerName: optionalText(80),
  /** Contact details for lucky-draw schemes; only stored when the customer consents. */
  customer: z
    .object({
      name: z.string().trim().min(2, 'Customer name is required').max(80),
      phone: phoneSchema,
      consent: z.literal(true, { message: 'The customer must agree before their contact details are stored' }),
    })
    .optional()
    .nullable(),
});

export const salesQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  fiscalYear: z.string().max(10).optional(),
  status: z.enum(['all', 'completed', 'voided', 'partially_returned', 'returned']).default('all'),
  q: z.string().trim().max(50).optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(5).max(200).default(25),
});

export const voidSaleSchema = z.object({
  saleId: id,
  reason: z.string().trim().min(5, 'Give a reason of at least 5 characters').max(300),
  override: overrideSchema,
});

export const returnSchema = z.object({
  saleId: id,
  items: z.array(z.object({ saleItemId: id, quantity: z.number().int().min(1).max(10_000) })).min(1, 'Select at least one item'),
  reason: z.string().trim().min(5, 'Give a reason of at least 5 characters').max(300),
  restock: z.boolean().default(true),
  override: overrideSchema,
});

export const supplierInputSchema = z.object({
  name: z.string().trim().min(2).max(120),
  contactName: optionalText(80),
  phone: optionalText(30),
  email: z.string().trim().email().max(120).optional().nullable().or(z.literal('')).transform((v) => (v ? v : null)),
  address: optionalText(200),
  panVat: optionalText(30),
  notes: optionalText(300),
});

export const purchaseInputSchema = z.object({
  supplierId: id,
  invoiceNo: z.string().trim().min(1, 'Supplier invoice number is required').max(50),
  invoiceDate: isoDate,
  notes: optionalText(300),
  updateCostPrice: z.boolean().default(true),
  items: z
    .array(
      z.object({
        productId: id,
        quantity: z.number().int().min(1).max(1_000_000),
        unitCostPaisa: paisa,
        batchNo: optionalText(40),
        expiryDate: isoDate.optional().nullable(),
      }),
    )
    .min(1, 'Add at least one item'),
});

export const adjustmentSchema = z.object({
  productId: id,
  quantityDelta: z.number().int().min(-1_000_000).max(1_000_000).refine((v) => v !== 0, 'Adjustment cannot be zero'),
  reason: z.enum(['count_correction', 'damaged', 'expired', 'lost_or_stolen', 'internal_use', 'other']),
  note: z.string().trim().min(3, 'Add a short note').max(300),
});

export const userInputSchema = z.object({
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,30}$/, '3–30 characters: letters, digits, . _ -'),
  fullName: z.string().trim().min(2).max(80),
  role: z.enum(['admin', 'cashier']),
  password: z.string().min(8, 'Password must be at least 8 characters').max(200),
});

export const userUpdateSchema = z.object({
  id,
  fullName: z.string().trim().min(2).max(80),
  role: z.enum(['admin', 'cashier']),
  active: z.boolean(),
});

const labelSize = z.object({
  widthMm: z.number().min(15).max(150),
  heightMm: z.number().min(10).max(150),
  marginMm: z.number().min(0).max(20),
  gapMm: z.number().min(0).max(20),
  columns: z.number().int().min(1).max(8),
  pageWidthMm: z.number().min(20).max(330),
});

export const settingsSchema = z.object({
  store: z.object({
    name: z.string().trim().min(1).max(80),
    tagline: z.string().trim().max(120),
    address: z.string().trim().max(200),
    phone: z.string().trim().max(40),
    email: z.string().trim().max(120),
    /** PAN/VAT registration — left blank until the store supplies its real number. */
    panVat: z.string().trim().max(30),
  }),
  receipt: z.object({
    header: z.string().max(300),
    footer: z.string().max(300),
    showBsDate: z.boolean(),
    paperWidthMm: z.union([z.literal(80), z.literal(58)]),
    prefix: z.string().trim().regex(/^[A-Z]{2,6}$/, '2–6 capital letters'),
  }),
  currency: z.object({ code: z.literal('NPR'), symbol: z.string().trim().min(1).max(5) }),
  paymentMethods: z
    .array(z.object({ code: z.string().regex(/^[a-z_]{2,20}$/), label: z.string().trim().min(1).max(30), enabled: z.boolean(), requiresReference: z.boolean() }))
    .min(1),
  tax: z.object({
    enabled: z.boolean(),
    verified: z.boolean(),
    verificationNote: z.string().max(500),
    label: z.string().trim().max(20),
    rateBp: z.number().int().min(0).max(5000),
    inclusive: z.boolean(),
  }),
  printers: z.object({
    receiptPrinter: z.string().max(200).nullable(),
    labelPrinter: z.string().max(200).nullable(),
    silentReceipt: z.boolean(),
    autoPrintReceipt: z.boolean(),
  }),
  labels: z.object({ sticker: labelSize, shelf: labelSize }),
  pos: z.object({
    scanDebounceMs: z.number().int().min(0).max(3000),
    cashierMaxDiscountBp: z.number().int().min(0).max(10000),
    allowNegativeStock: z.boolean(),
  }),
  mobile: z.object({ enabled: z.boolean(), port: z.number().int().min(1024).max(65535) }),
  scanner: z.object({
    /** USB/Bluetooth HID scanners that type like a keyboard. */
    usbEnabled: z.boolean(),
    /** Phone camera scanner paired by QR code over the shop Wi-Fi (HTTPS, self-signed). */
    phoneEnabled: z.boolean(),
    phonePort: z.number().int().min(1024).max(65535),
  }),
  backup: z.object({ directory: z.string().max(500).nullable(), autoBackupOnExit: z.boolean(), keep: z.number().int().min(3).max(365) }),
});

export const dateRangeSchema = z.object({ from: isoDate, to: isoDate });
export const salesReportSchema = dateRangeSchema.extend({ groupBy: z.enum(['day', 'week', 'month']).default('day') });

export const labelJobSchema = z.object({
  template: z.enum(['sticker', 'shelf']),
  items: z.array(z.object({ productId: id, copies: z.number().int().min(1).max(500) })).min(1, 'Select at least one product').max(500),
});

export const promotionInputSchema = z
  .object({
    name: z.string().trim().min(3, 'Give the offer a name, e.g. "Dashain offer"').max(60),
    percentBp: z.number().int().min(1, 'Discount must be more than 0%').max(9000, 'Discount cannot exceed 90%'),
    categoryId: id.nullable(),
    startsOn: isoDate,
    endsOn: isoDate,
    active: z.boolean().default(true),
  })
  .refine((p) => p.endsOn >= p.startsOn, { message: 'End date must be on or after the start date', path: ['endsOn'] });

export const schemeInputSchema = z
  .object({
    name: z.string().trim().min(3).max(60),
    description: z.string().trim().max(300).default(''),
    minBillPaisa: paisa.refine((v) => v >= 100, 'Minimum bill must be at least Rs. 1'),
    /** Optional: one extra coupon for every additional step amount (e.g. 1 coupon per Rs 1,000). */
    entryStepPaisa: paisa.nullable(),
    startsOn: isoDate,
    endsOn: isoDate,
    couponPrefix: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,10}$/, '2–10 letters/digits'),
    active: z.boolean().default(true),
  })
  .refine((p) => p.endsOn >= p.startsOn, { message: 'End date must be on or after the start date', path: ['endsOn'] })
  .refine((p) => p.entryStepPaisa === null || p.entryStepPaisa >= 100, { message: 'Coupon step must be at least Rs. 1', path: ['entryStepPaisa'] });

export const drawSchema = z.object({
  schemeId: id,
  prize: z.string().trim().min(2, 'Name the prize').max(80),
  count: z.number().int().min(1).max(50),
  allowBeforeEnd: z.boolean().default(false),
});

export type PromotionInput = z.input<typeof promotionInputSchema>;
export type SchemeInput = z.input<typeof schemeInputSchema>;
export type DrawInput = z.input<typeof drawSchema>;
export type ProductInput = z.input<typeof productInputSchema>;
export type ProductUpdate = z.input<typeof productUpdateSchema>;
export type ProductQuery = z.input<typeof productQuerySchema>;
export type CartLineInput = z.input<typeof cartLineSchema>;
export type SaleQuoteInput = z.input<typeof saleQuoteSchema>;
export type CompleteSaleInput = z.input<typeof completeSaleSchema>;
export type SalesQuery = z.input<typeof salesQuerySchema>;
export type VoidSaleInput = z.input<typeof voidSaleSchema>;
export type ReturnInput = z.input<typeof returnSchema>;
export type SupplierInput = z.input<typeof supplierInputSchema>;
export type PurchaseInput = z.input<typeof purchaseInputSchema>;
export type AdjustmentInput = z.input<typeof adjustmentSchema>;
export type UserInput = z.input<typeof userInputSchema>;
export type UserUpdate = z.input<typeof userUpdateSchema>;
export type AppSettings = z.output<typeof settingsSchema>;
export type LabelJob = z.input<typeof labelJobSchema>;
export type Credentials = z.input<typeof credentialsSchema>;
export type LabelSize = z.output<typeof labelSize>;

export const openShiftSchema = z.object({ openingPaisa: paisa });
export const cashMovementSchema = z.object({
  shiftId: id, clientTxnId: z.string().uuid(), kind: z.enum(['in', 'out']),
  amountPaisa: paisa.refine((n) => n > 0, 'Amount must be greater than zero'),
  reason: z.string().trim().min(3, 'Give a short reason').max(300),
});
export const closeShiftSchema = z.object({
  shiftId: id, countedPaisa: paisa,
  expectedPaisa: z.number().int().min(-1_000_000_000_000).max(1_000_000_000_000),
  note: z.string().trim().max(300).default(''),
});
export const cartSaveSchema = z.object({
  id: z.string().uuid(), revision: z.number().int().min(0),
  lines: z.array(cartLineSchema).max(300), orderDiscountPaisa: paisa.default(0),
});
export const cartActionSchema = z.object({ id: z.string().uuid(), revision: z.number().int().positive() });
export const parkCartSchema = cartActionSchema.extend({ name: z.string().trim().min(1, 'Name this cart').max(80) });
export type OpenShiftInput = z.input<typeof openShiftSchema>;
export type CashMovementInput = z.input<typeof cashMovementSchema>;
export type CloseShiftInput = z.input<typeof closeShiftSchema>;
export type CartSaveInput = z.input<typeof cartSaveSchema>;
export type CartActionInput = z.input<typeof cartActionSchema>;
export type ParkCartInput = z.input<typeof parkCartSchema>;
