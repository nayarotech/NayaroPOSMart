import type { Category, Page, PriceHistoryEntry, Product, ProductBarcode, Symbology } from '@srmart/shared';
import type { Ctx } from '../context';
import { bool } from '../db/database';

function mapBarcode(r: Record<string, unknown>): ProductBarcode {
  return {
    id: r.id as number,
    productId: r.product_id as number,
    code: r.code as string,
    symbology: r.symbology as Symbology,
    source: r.source as 'manufacturer' | 'internal',
    isPrimary: bool(r.is_primary),
    createdAt: r.created_at as string,
  };
}

function mapProduct(r: Record<string, unknown>, barcodes: ProductBarcode[]): Product {
  const priceChangedAt = (r.price_changed_at as string) ?? null;
  const labelPrintedAt = (r.label_printed_at as string) ?? null;
  return {
    id: r.id as number,
    sku: r.sku as string,
    name: r.name as string,
    categoryId: (r.category_id as number) ?? null,
    categoryName: (r.category_name as string) ?? null,
    brand: (r.brand as string) ?? null,
    unit: r.unit as string,
    costPaisa: r.cost_paisa as number,
    pricePaisa: r.price_paisa as number,
    qtyOnHand: r.qty_on_hand as number,
    minStock: r.min_stock as number,
    trackExpiry: bool(r.track_expiry),
    active: bool(r.active),
    isDemo: bool(r.is_demo),
    priceChangedAt,
    labelPrintedAt,
    labelOutdated: !!labelPrintedAt && !!priceChangedAt && priceChangedAt > labelPrintedAt,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    barcodes,
  };
}

const SELECT = `SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON c.id = p.category_id`;

export interface ProductFilter {
  q?: string;
  categoryId?: number | null;
  status: 'active' | 'inactive' | 'all';
  stock: 'all' | 'low' | 'out';
  page: number;
  pageSize: number;
}

export class ProductRepo {
  constructor(private ctx: Ctx) {}

  private barcodesFor(ids: number[]): Map<number, ProductBarcode[]> {
    const map = new Map<number, ProductBarcode[]>();
    if (!ids.length) return map;
    const rows = this.ctx.db
      .prepare(`SELECT * FROM product_barcodes WHERE product_id IN (SELECT value FROM json_each(?)) ORDER BY is_primary DESC, id`)
      .all(JSON.stringify(ids)) as Record<string, unknown>[];
    for (const r of rows) {
      const b = mapBarcode(r);
      const list = map.get(b.productId) ?? [];
      list.push(b);
      map.set(b.productId, list);
    }
    return map;
  }

  private hydrate(rows: Record<string, unknown>[]): Product[] {
    const bc = this.barcodesFor(rows.map((r) => r.id as number));
    return rows.map((r) => mapProduct(r, bc.get(r.id as number) ?? []));
  }

  byId(id: number): Product | null {
    const r = this.ctx.db.prepare(`${SELECT} WHERE p.id = ?`).get(id) as Record<string, unknown> | undefined;
    return r ? this.hydrate([r])[0]! : null;
  }

  byIds(ids: number[]): Product[] {
    if (!ids.length) return [];
    const rows = this.ctx.db.prepare(`${SELECT} WHERE p.id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids)) as Record<string, unknown>[];
    return this.hydrate(rows);
  }

  bySku(sku: string): Product | null {
    const r = this.ctx.db.prepare(`${SELECT} WHERE p.sku = ?`).get(sku) as Record<string, unknown> | undefined;
    return r ? this.hydrate([r])[0]! : null;
  }

  byBarcode(code: string): Product | null {
    const r = this.ctx.db
      .prepare(`${SELECT} JOIN product_barcodes b ON b.product_id = p.id WHERE b.code = ?`)
      .get(code) as Record<string, unknown> | undefined;
    return r ? this.hydrate([r])[0]! : null;
  }

  list(f: ProductFilter): Page<Product> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (f.status === 'active') where.push('p.active = 1');
    if (f.status === 'inactive') where.push('p.active = 0');
    if (f.categoryId) {
      where.push('p.category_id = ?');
      params.push(f.categoryId);
    }
    if (f.stock === 'low') where.push('p.qty_on_hand <= p.min_stock AND p.qty_on_hand > 0');
    if (f.stock === 'out') where.push('p.qty_on_hand <= 0');
    if (f.q) {
      const like = `%${f.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      where.push(`(p.name LIKE ? ESCAPE '\\' OR p.sku LIKE ? ESCAPE '\\' OR p.brand LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM product_barcodes b WHERE b.product_id = p.id AND b.code LIKE ? ESCAPE '\\'))`);
      params.push(like, like, like, like);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (this.ctx.db.prepare(`SELECT COUNT(*) n FROM products p ${w}`).get(...params) as { n: number }).n;
    const rows = this.ctx.db
      .prepare(`${SELECT} ${w} ORDER BY p.name COLLATE NOCASE LIMIT ? OFFSET ?`)
      .all(...params, f.pageSize, (f.page - 1) * f.pageSize) as Record<string, unknown>[];
    return { rows: this.hydrate(rows), total, page: f.page, pageSize: f.pageSize };
  }

  search(q: string, limit: number): Product[] {
    return this.list({ q, status: 'active', stock: 'all', page: 1, pageSize: limit }).rows;
  }

  lowStock(limit = 200): Product[] {
    const rows = this.ctx.db
      .prepare(`${SELECT} WHERE p.active = 1 AND p.qty_on_hand <= p.min_stock ORDER BY (p.qty_on_hand - p.min_stock), p.name LIMIT ?`)
      .all(limit) as Record<string, unknown>[];
    return this.hydrate(rows);
  }

  countLowStock(): number {
    return (this.ctx.db.prepare('SELECT COUNT(*) n FROM products WHERE active = 1 AND qty_on_hand <= min_stock').get() as { n: number }).n;
  }

  countOutdatedLabels(): number {
    return (
      this.ctx.db
        .prepare('SELECT COUNT(*) n FROM products WHERE active = 1 AND label_printed_at IS NOT NULL AND price_changed_at > label_printed_at')
        .get() as { n: number }
    ).n;
  }

  all(): Product[] {
    return this.hydrate(this.ctx.db.prepare(`${SELECT} ORDER BY p.id`).all() as Record<string, unknown>[]);
  }

  insert(p: {
    sku: string;
    name: string;
    categoryId: number | null;
    brand: string | null;
    unit: string;
    costPaisa: number;
    pricePaisa: number;
    minStock: number;
    trackExpiry: boolean;
    active: boolean;
    isDemo: number;
  }): number {
    const now = this.ctx.clock.now().toISOString();
    const res = this.ctx.db
      .prepare(
        `INSERT INTO products (sku, name, category_id, brand, unit, cost_paisa, price_paisa, qty_on_hand, min_stock, track_expiry, active, is_demo, price_changed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(p.sku, p.name, p.categoryId, p.brand, p.unit, p.costPaisa, p.pricePaisa, p.minStock, p.trackExpiry ? 1 : 0, p.active ? 1 : 0, p.isDemo, now, now, now);
    return Number(res.lastInsertRowid);
  }

  update(id: number, p: { name: string; categoryId: number | null; brand: string | null; unit: string; costPaisa: number; pricePaisa: number; minStock: number; trackExpiry: boolean; priceChanged: boolean }) {
    const now = this.ctx.clock.now().toISOString();
    this.ctx.db
      .prepare(
        `UPDATE products SET name = ?, category_id = ?, brand = ?, unit = ?, cost_paisa = ?, price_paisa = ?, min_stock = ?, track_expiry = ?,
           price_changed_at = CASE WHEN ? THEN ? ELSE price_changed_at END, updated_at = ? WHERE id = ?`,
      )
      .run(p.name, p.categoryId, p.brand, p.unit, p.costPaisa, p.pricePaisa, p.minStock, p.trackExpiry ? 1 : 0, p.priceChanged ? 1 : 0, now, now, id);
  }

  setCost(id: number, costPaisa: number) {
    this.ctx.db.prepare('UPDATE products SET cost_paisa = ?, updated_at = ? WHERE id = ?').run(costPaisa, this.ctx.clock.now().toISOString(), id);
  }

  setActive(id: number, active: boolean) {
    this.ctx.db.prepare('UPDATE products SET active = ?, updated_at = ? WHERE id = ?').run(active ? 1 : 0, this.ctx.clock.now().toISOString(), id);
  }

  markLabelsPrinted(ids: number[]) {
    this.ctx.db
      .prepare('UPDATE products SET label_printed_at = ? WHERE id IN (SELECT value FROM json_each(?))')
      .run(this.ctx.clock.now().toISOString(), JSON.stringify(ids));
  }

  // --- barcodes ---
  barcodeByCode(code: string): ProductBarcode | null {
    const r = this.ctx.db.prepare('SELECT * FROM product_barcodes WHERE code = ?').get(code) as Record<string, unknown> | undefined;
    return r ? mapBarcode(r) : null;
  }

  barcodeById(id: number): ProductBarcode | null {
    const r = this.ctx.db.prepare('SELECT * FROM product_barcodes WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? mapBarcode(r) : null;
  }

  insertBarcode(b: { productId: number; code: string; symbology: Symbology; source: 'manufacturer' | 'internal'; isPrimary: boolean }): number {
    const res = this.ctx.db
      .prepare('INSERT INTO product_barcodes (product_id, code, symbology, source, is_primary, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(b.productId, b.code, b.symbology, b.source, b.isPrimary ? 1 : 0, this.ctx.clock.now().toISOString());
    return Number(res.lastInsertRowid);
  }

  deleteBarcode(id: number) {
    this.ctx.db.prepare('DELETE FROM product_barcodes WHERE id = ?').run(id);
  }

  setPrimaryBarcode(productId: number, barcodeId: number) {
    this.ctx.db.prepare('UPDATE product_barcodes SET is_primary = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE product_id = ?').run(barcodeId, productId);
  }

  // --- price history ---
  insertPrice(productId: number, pricePaisa: number, costPaisa: number, userId: number | null, reason: string | null) {
    this.ctx.db
      .prepare('INSERT INTO product_prices (product_id, price_paisa, cost_paisa, effective_from, changed_by, reason) VALUES (?, ?, ?, ?, ?, ?)')
      .run(productId, pricePaisa, costPaisa, this.ctx.clock.now().toISOString(), userId, reason);
  }

  priceHistory(productId: number): PriceHistoryEntry[] {
    return (
      this.ctx.db
        .prepare(
          `SELECT pp.*, u.full_name AS user_name FROM product_prices pp LEFT JOIN users u ON u.id = pp.changed_by
           WHERE pp.product_id = ? ORDER BY pp.id DESC LIMIT 50`,
        )
        .all(productId) as Record<string, unknown>[]
    ).map((r) => ({
      id: r.id as number,
      pricePaisa: r.price_paisa as number,
      costPaisa: r.cost_paisa as number,
      effectiveFrom: r.effective_from as string,
      changedBy: (r.user_name as string) ?? null,
      reason: (r.reason as string) ?? null,
    }));
  }

  // --- categories ---
  categories(): Category[] {
    return (
      this.ctx.db
        .prepare(
          `SELECT c.id, c.name, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.active = 1) AS product_count
           FROM categories c ORDER BY c.name COLLATE NOCASE`,
        )
        .all() as Record<string, unknown>[]
    ).map((r) => ({ id: r.id as number, name: r.name as string, productCount: r.product_count as number }));
  }

  categoryByName(name: string): Category | null {
    return this.categories().find((c) => c.name.toLowerCase() === name.toLowerCase()) ?? null;
  }

  insertCategory(name: string, isDemo: number): number {
    const res = this.ctx.db.prepare('INSERT INTO categories (name, is_demo, created_at) VALUES (?, ?, ?)').run(name, isDemo, this.ctx.clock.now().toISOString());
    return Number(res.lastInsertRowid);
  }
}
