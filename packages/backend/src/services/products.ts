import Papa from 'papaparse';
import type { ImportReport, ImportRowResult, Product, ProductBarcode, SessionUser, Symbology } from '@srmart/shared';
import { barcodeValueSchema, parseRupees, productInputSchema, productQuerySchema, productUpdateSchema, symbologySchema } from '@srmart/shared';
import type { Ctx } from '../context';
import { tx } from '../db/database';
import { ZodError } from 'zod';
import { AppError, conflict, invalid, notFound, toAppError } from '../errors';
import { AuditRepo } from '../repositories/auditRepo';
import { ProductRepo } from '../repositories/productRepo';
import { SequenceRepo } from '../repositories/sequenceRepo';
import { SettingsRepo } from '../repositories/settingsRepo';
import { StockRepo } from '../repositories/stockRepo';
import { requireRole } from './auth';

/** GS1 mod-10 check digit for EAN-8 / UPC-A / EAN-13 payloads (without the check digit). */
export function gs1CheckDigit(payload: string): number {
  let sum = 0;
  const digits = payload.split('').reverse();
  digits.forEach((d, i) => {
    sum += Number(d) * (i % 2 === 0 ? 3 : 1);
  });
  return (10 - (sum % 10)) % 10;
}

export function isValidGs1(code: string): boolean {
  if (!/^\d+$/.test(code) || ![8, 12, 13].includes(code.length)) return false;
  return gs1CheckDigit(code.slice(0, -1)) === Number(code.at(-1));
}

/** Infers a symbology for a scanned/typed manufacturer barcode. */
export function detectSymbology(code: string): Symbology {
  if (/^\d{13}$/.test(code) && isValidGs1(code)) return 'EAN13';
  if (/^\d{12}$/.test(code) && isValidGs1(code)) return 'UPCA';
  if (/^\d{8}$/.test(code) && isValidGs1(code)) return 'EAN8';
  if (/^[\x20-\x7E]+$/.test(code)) return 'CODE128';
  return 'OTHER';
}

export function formatSku(n: number) {
  return `NYM-${String(n).padStart(6, '0')}`;
}

const CSV_COLUMNS = ['sku', 'name', 'category', 'brand', 'unit', 'cost_price', 'selling_price', 'qty_on_hand', 'min_stock', 'barcode', 'barcode_type', 'track_expiry', 'active'] as const;

export class ProductService {
  readonly repo: ProductRepo;
  private stock: StockRepo;
  private audit: AuditRepo;
  private seq: SequenceRepo;
  private settings: SettingsRepo;

  constructor(private ctx: Ctx) {
    this.repo = new ProductRepo(ctx);
    this.stock = new StockRepo(ctx);
    this.audit = new AuditRepo(ctx);
    this.seq = new SequenceRepo(ctx);
    this.settings = new SettingsRepo(ctx);
  }

  list(input: unknown) {
    const q = productQuerySchema.parse(input ?? {});
    return this.repo.list(q);
  }

  get(id: number) {
    const p = this.repo.byId(id);
    if (!p) throw notFound('Product');
    return { ...p, priceHistory: this.repo.priceHistory(id) };
  }

  lookupBarcode(code: string): Product | null {
    const value = String(code ?? '').trim();
    if (!value) return null;
    const p = this.repo.byBarcode(value) ?? this.repo.bySku(value.toUpperCase());
    return p && p.active ? p : null;
  }

  search(q: string, limit = 12) {
    const text = String(q ?? '').trim().slice(0, 100);
    if (!text) return [];
    return this.repo.search(text, Math.min(Math.max(limit, 1), 50));
  }

  private nextSku(): string {
    for (;;) {
      const sku = formatSku(this.seq.nextId('SKU'));
      if (!this.repo.bySku(sku) && !this.repo.barcodeByCode(sku)) return sku;
    }
  }

  private assertBarcodeFree(code: string, productId?: number) {
    const existing = this.repo.barcodeByCode(code);
    if (existing) {
      const owner = this.repo.byId(existing.productId);
      if (existing.productId === productId) throw conflict(`Barcode ${code} is already registered on this product`);
      throw conflict(`Barcode ${code} is already assigned to ${owner?.name ?? 'another product'} (${owner?.sku ?? '?'})`);
    }
    const skuOwner = this.repo.bySku(code);
    if (skuOwner && skuOwner.id !== productId) throw conflict(`${code} is the internal SKU of ${skuOwner.name}; it cannot be used as another product's barcode`);
  }

  private validateBarcode(code: string, symbology?: Symbology): Symbology {
    const value = barcodeValueSchema.parse(code);
    if (!symbology && /^(\d{8}|\d{12}|\d{13})$/.test(value) && !isValidGs1(value)) {
      throw invalid(`${value} looks like an EAN/UPC but its check digit is wrong — rescan it, or choose type CODE128/OTHER if the printed code really is non-standard`);
    }
    const sym = symbology ?? detectSymbology(value);
    if ((sym === 'EAN13' || sym === 'UPCA' || sym === 'EAN8') && !isValidGs1(value)) {
      throw invalid(`${value} is not a valid ${sym} barcode (wrong length or check digit)`);
    }
    return sym;
  }

  create(user: SessionUser, input: unknown): Product {
    requireRole(user, 'admin');
    const p = productInputSchema.parse(input);
    return tx(this.ctx.db, () => this.createInTx(user, p));
  }

  /** Assumes validated input and an open transaction. */
  private createInTx(user: SessionUser, p: ReturnType<typeof productInputSchema.parse>): Product {
    const isDemo = this.settings.isDemo();
    const sku = this.nextSku();
    const id = this.repo.insert({ sku, name: p.name, categoryId: p.categoryId, brand: p.brand, unit: p.unit, costPaisa: p.costPaisa, pricePaisa: p.pricePaisa, minStock: p.minStock, trackExpiry: p.trackExpiry, active: p.active, isDemo });
    this.repo.insertPrice(id, p.pricePaisa, p.costPaisa, user.id, 'Initial price');
    if (p.barcode) {
      const sym = this.validateBarcode(p.barcode, p.barcodeSymbology);
      this.assertBarcodeFree(p.barcode, id);
      this.repo.insertBarcode({ productId: id, code: p.barcode, symbology: sym, source: 'manufacturer', isPrimary: true });
    } else if (p.generateInternalBarcode !== false) {
      this.repo.insertBarcode({ productId: id, code: sku, symbology: 'CODE128', source: 'internal', isPrimary: true });
    }
    if (p.openingQty && p.openingQty > 0) {
      this.stock.move({ productId: id, type: 'opening', quantityDelta: p.openingQty, reason: 'Opening stock', refType: 'product', refId: id, refLabel: sku, userId: user.id, isDemo });
    }
    this.audit.log({ action: 'product.created', entityType: 'product', entityId: id, userId: user.id, details: { sku, name: p.name, pricePaisa: p.pricePaisa, openingQty: p.openingQty ?? 0 } });
    return this.repo.byId(id)!;
  }

  update(user: SessionUser, input: unknown): Product {
    requireRole(user, 'admin');
    const u = productUpdateSchema.parse(input);
    return tx(this.ctx.db, () => {
      const before = this.repo.byId(u.id);
      if (!before) throw notFound('Product');
      const priceChanged = before.pricePaisa !== u.pricePaisa;
      const costChanged = before.costPaisa !== u.costPaisa;
      this.repo.update(u.id, { ...u, priceChanged });
      if (priceChanged || costChanged) {
        this.repo.insertPrice(u.id, u.pricePaisa, u.costPaisa, user.id, u.priceChangeReason ?? null);
      }
      if (priceChanged) {
        this.audit.log({ action: 'product.price_changed', entityType: 'product', entityId: u.id, userId: user.id, details: { sku: before.sku, oldPricePaisa: before.pricePaisa, newPricePaisa: u.pricePaisa, reason: u.priceChangeReason ?? null } });
      }
      if (costChanged) {
        this.audit.log({ action: 'product.cost_changed', entityType: 'product', entityId: u.id, userId: user.id, details: { sku: before.sku, oldCostPaisa: before.costPaisa, newCostPaisa: u.costPaisa } });
      }
      this.audit.log({ action: 'product.updated', entityType: 'product', entityId: u.id, userId: user.id, details: { name: u.name } });
      return this.repo.byId(u.id)!;
    });
  }

  setActive(user: SessionUser, id: number, active: boolean): Product {
    requireRole(user, 'admin');
    return tx(this.ctx.db, () => {
      if (!this.repo.byId(id)) throw notFound('Product');
      this.repo.setActive(id, active);
      this.audit.log({ action: active ? 'product.enabled' : 'product.disabled', entityType: 'product', entityId: id, userId: user.id });
      return this.repo.byId(id)!;
    });
  }

  // ---------------- barcodes ----------------
  addBarcode(user: SessionUser, productId: number, code: string, symbology?: Symbology): ProductBarcode {
    requireRole(user, 'admin');
    const sym = this.validateBarcode(code, symbology ? symbologySchema.parse(symbology) : undefined);
    const value = code.trim();
    return tx(this.ctx.db, () => {
      const product = this.repo.byId(productId);
      if (!product) throw notFound('Product');
      this.assertBarcodeFree(value, productId);
      const id = this.repo.insertBarcode({ productId, code: value, symbology: sym, source: 'manufacturer', isPrimary: product.barcodes.length === 0 });
      this.audit.log({ action: 'barcode.added', entityType: 'product', entityId: productId, userId: user.id, details: { code: value, symbology: sym } });
      return this.repo.barcodeById(id)!;
    });
  }

  generateInternalBarcode(user: SessionUser, productId: number): ProductBarcode {
    requireRole(user, 'admin');
    return tx(this.ctx.db, () => {
      const product = this.repo.byId(productId);
      if (!product) throw notFound('Product');
      const existing = product.barcodes.find((b) => b.source === 'internal');
      if (existing) return existing;
      // Prefer the product's own SKU; fall back to a fresh SKU-format value if it was taken.
      const code = this.repo.barcodeByCode(product.sku) ? this.nextSku() : product.sku;
      const id = this.repo.insertBarcode({ productId, code, symbology: 'CODE128', source: 'internal', isPrimary: product.barcodes.length === 0 });
      this.audit.log({ action: 'barcode.generated', entityType: 'product', entityId: productId, userId: user.id, details: { code } });
      return this.repo.barcodeById(id)!;
    });
  }

  removeBarcode(user: SessionUser, barcodeId: number) {
    requireRole(user, 'admin');
    tx(this.ctx.db, () => {
      const b = this.repo.barcodeById(barcodeId);
      if (!b) throw notFound('Barcode');
      this.repo.deleteBarcode(barcodeId);
      const remaining = this.repo.byId(b.productId)!.barcodes;
      if (b.isPrimary && remaining[0]) this.repo.setPrimaryBarcode(b.productId, remaining[0].id);
      this.audit.log({ action: 'barcode.removed', entityType: 'product', entityId: b.productId, userId: user.id, details: { code: b.code } });
    });
    return { ok: true as const };
  }

  setPrimaryBarcode(user: SessionUser, barcodeId: number) {
    requireRole(user, 'admin');
    const b = this.repo.barcodeById(barcodeId);
    if (!b) throw notFound('Barcode');
    tx(this.ctx.db, () => this.repo.setPrimaryBarcode(b.productId, barcodeId));
    return { ok: true as const };
  }

  // ---------------- categories ----------------
  createCategory(user: SessionUser, name: string) {
    requireRole(user, 'admin');
    const clean = String(name ?? '').trim();
    if (clean.length < 2 || clean.length > 60) throw invalid('Category name must be 2–60 characters');
    if (this.repo.categoryByName(clean)) throw conflict(`Category "${clean}" already exists`);
    this.repo.insertCategory(clean, this.settings.isDemo());
    this.audit.log({ action: 'category.created', entityType: 'category', entityId: clean, userId: user.id });
    return this.repo.categoryByName(clean)!;
  }

  // ---------------- CSV ----------------
  exportCsv(): { csv: string; count: number } {
    const rows = this.repo.all().map((p) => {
      const primary = p.barcodes.find((b) => b.isPrimary) ?? p.barcodes[0];
      return {
        sku: p.sku,
        name: p.name,
        category: p.categoryName ?? '',
        brand: p.brand ?? '',
        unit: p.unit,
        cost_price: (p.costPaisa / 100).toFixed(2),
        selling_price: (p.pricePaisa / 100).toFixed(2),
        qty_on_hand: p.qtyOnHand,
        min_stock: p.minStock,
        barcode: primary?.code ?? '',
        barcode_type: primary?.symbology ?? '',
        track_expiry: p.trackExpiry ? 'yes' : 'no',
        active: p.active ? 'yes' : 'no',
      };
    });
    return { csv: Papa.unparse({ fields: [...CSV_COLUMNS], data: rows.map((r) => CSV_COLUMNS.map((c) => r[c])) }), count: rows.length };
  }

  /**
   * Two-phase import: commit=false validates and reports; commit=true imports all valid rows
   * in one transaction (duplicates and errors are skipped and reported, never half-applied).
   */
  importCsv(user: SessionUser, csv: string, commit: boolean): ImportReport {
    requireRole(user, 'admin');
    if (typeof csv !== 'string' || !csv.trim()) throw invalid('The CSV file is empty');
    if (csv.length > 5_000_000) throw invalid('CSV file is too large (max 5 MB)');
    const parsed = Papa.parse<Record<string, string>>(csv.replace(/^\uFEFF/, ''), { header: true, skipEmptyLines: 'greedy', transformHeader: (h) => h.trim().toLowerCase().replace(/\s+/g, '_') });
    if (!parsed.meta.fields?.includes('name') || !parsed.meta.fields.includes('selling_price')) {
      throw invalid('CSV must have at least "name" and "selling_price" columns. Export the product list to get a template.');
    }
    if (parsed.data.length > 5000) throw invalid('Import at most 5,000 rows at a time');

    const seenBarcodes = new Set<string>();
    const seenSkus = new Set<string>();
    const results: ImportRowResult[] = [];
    const valid: { row: number; data: ReturnType<typeof productInputSchema.parse>; category: string | null }[] = [];

    parsed.data.forEach((raw, i) => {
      const row = i + 2; // header is row 1
      const name = (raw.name ?? '').trim();
      try {
        const price = parseRupees(raw.selling_price ?? '');
        const cost = raw.cost_price?.trim() ? parseRupees(raw.cost_price) : 0;
        if (price === null) throw new Error('selling_price is not a valid amount');
        if (cost === null) throw new Error('cost_price is not a valid amount');
        const qty = raw.qty_on_hand?.trim() ? Number(raw.qty_on_hand) : 0;
        const min = raw.min_stock?.trim() ? Number(raw.min_stock) : 0;
        if (!Number.isInteger(qty) || qty < 0) throw new Error('qty_on_hand must be a whole number ≥ 0');
        if (!Number.isInteger(min) || min < 0) throw new Error('min_stock must be a whole number ≥ 0');
        const barcode = raw.barcode?.trim() || null;
        const sku = raw.sku?.trim().toUpperCase() || null;
        if (barcode) {
          if (seenBarcodes.has(barcode)) {
            results.push({ row, status: 'duplicate', name, message: `Barcode ${barcode} appears more than once in this file` });
            return;
          }
          seenBarcodes.add(barcode);
          const owner = this.repo.byBarcode(barcode);
          if (owner) {
            results.push({ row, status: 'duplicate', name, message: `Barcode ${barcode} already belongs to ${owner.name} (${owner.sku})` });
            return;
          }
          const symRaw = raw.barcode_type?.trim().toUpperCase();
          this.validateBarcode(barcode, symRaw ? symbologySchema.parse(symRaw) : undefined);
        }
        if (sku) {
          if (seenSkus.has(sku) || this.repo.bySku(sku)) {
            results.push({ row, status: 'duplicate', name, message: `SKU ${sku} already exists — existing products are not overwritten by import` });
            return;
          }
          seenSkus.add(sku);
        }
        const data = productInputSchema.parse({
          name,
          categoryId: null,
          brand: raw.brand ?? null,
          unit: raw.unit?.trim() || 'pcs',
          costPaisa: cost,
          pricePaisa: price,
          minStock: min,
          trackExpiry: /^(y|yes|true|1)$/i.test(raw.track_expiry ?? ''),
          active: !/^(n|no|false|0)$/i.test(raw.active ?? ''),
          openingQty: qty,
          barcode,
          barcodeSymbology: raw.barcode_type?.trim() ? (raw.barcode_type.trim().toUpperCase() as Symbology) : undefined,
          generateInternalBarcode: !barcode,
        });
        valid.push({ row, data, category: raw.category?.trim() || null });
        results.push({ row, status: 'ok', name, message: barcode ? `Will import with barcode ${barcode}` : 'Will import with a generated internal barcode' });
      } catch (err) {
        const msg = err instanceof AppError || err instanceof ZodError ? toAppError(err).message : err instanceof Error ? err.message : 'Invalid row';
        results.push({ row, status: 'error', name, message: msg });
      }
    });

    if (commit && valid.length) {
      tx(this.ctx.db, () => {
        for (const v of valid) {
          let categoryId: number | null = null;
          if (v.category) categoryId = this.repo.categoryByName(v.category)?.id ?? this.repo.insertCategory(v.category, this.settings.isDemo());
          this.createInTx(user, { ...v.data, categoryId });
        }
        this.audit.log({ action: 'product.csv_import', entityType: 'product', userId: user.id, details: { imported: valid.length, skipped: results.length - valid.length } });
      });
    }
    results.sort((a, b) => a.row - b.row);
    return {
      committed: commit && valid.length > 0,
      total: results.length,
      ok: results.filter((r) => r.status === 'ok').length,
      duplicates: results.filter((r) => r.status === 'duplicate').length,
      errors: results.filter((r) => r.status === 'error').length,
      rows: results,
    };
  }
}
