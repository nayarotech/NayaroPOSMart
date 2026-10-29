import type { Page, PurchaseDetail, PurchaseSummary, Supplier } from '@srmart/shared';
import type { Ctx } from '../context';
import { bool } from '../db/database';

function mapSupplier(r: Record<string, unknown>): Supplier {
  return {
    id: r.id as number,
    name: r.name as string,
    contactName: (r.contact_name as string) ?? null,
    phone: (r.phone as string) ?? null,
    email: (r.email as string) ?? null,
    address: (r.address as string) ?? null,
    panVat: (r.pan_vat as string) ?? null,
    notes: (r.notes as string) ?? null,
    isDemo: bool(r.is_demo),
    purchaseCount: (r.purchase_count as number) ?? 0,
  };
}

const PURCHASE_SELECT = `SELECT pu.*, s.name AS supplier_name, u.full_name AS received_name,
  (SELECT COALESCE(SUM(quantity), 0) FROM purchase_items pi WHERE pi.purchase_id = pu.id) AS item_count
  FROM purchases pu JOIN suppliers s ON s.id = pu.supplier_id JOIN users u ON u.id = pu.received_by`;

function mapPurchase(r: Record<string, unknown>): PurchaseSummary {
  return {
    id: r.id as number,
    purchaseNo: r.purchase_no as string,
    supplierId: r.supplier_id as number,
    supplierName: r.supplier_name as string,
    invoiceNo: r.invoice_no as string,
    invoiceDate: r.invoice_date as string,
    fiscalYear: r.fiscal_year as string,
    totalPaisa: r.total_paisa as number,
    itemCount: r.item_count as number,
    receivedAt: r.received_at as string,
    receivedBy: r.received_name as string,
    isDemo: bool(r.is_demo),
  };
}

export interface SupplierFields {
  name: string;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  panVat: string | null;
  notes: string | null;
}

export class PurchaseRepo {
  constructor(private ctx: Ctx) {}

  suppliers(): Supplier[] {
    return (
      this.ctx.db
        .prepare('SELECT s.*, (SELECT COUNT(*) FROM purchases p WHERE p.supplier_id = s.id) AS purchase_count FROM suppliers s ORDER BY s.name COLLATE NOCASE')
        .all() as Record<string, unknown>[]
    ).map(mapSupplier);
  }

  supplier(id: number): Supplier | null {
    const r = this.ctx.db.prepare('SELECT s.*, (SELECT COUNT(*) FROM purchases p WHERE p.supplier_id = s.id) AS purchase_count FROM suppliers s WHERE s.id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? mapSupplier(r) : null;
  }

  insertSupplier(s: SupplierFields, isDemo: number): number {
    const now = this.ctx.clock.now().toISOString();
    const res = this.ctx.db
      .prepare('INSERT INTO suppliers (name, contact_name, phone, email, address, pan_vat, notes, is_demo, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(s.name, s.contactName, s.phone, s.email, s.address, s.panVat, s.notes, isDemo, now, now);
    return Number(res.lastInsertRowid);
  }

  updateSupplier(id: number, s: SupplierFields) {
    this.ctx.db
      .prepare('UPDATE suppliers SET name = ?, contact_name = ?, phone = ?, email = ?, address = ?, pan_vat = ?, notes = ?, updated_at = ? WHERE id = ?')
      .run(s.name, s.contactName, s.phone, s.email, s.address, s.panVat, s.notes, this.ctx.clock.now().toISOString(), id);
  }

  findByInvoice(supplierId: number, invoiceNo: string): number | null {
    const r = this.ctx.db.prepare('SELECT id FROM purchases WHERE supplier_id = ? AND invoice_no = ?').get(supplierId, invoiceNo) as { id: number } | undefined;
    return r?.id ?? null;
  }

  insertPurchase(p: { purchaseNo: string; supplierId: number; invoiceNo: string; invoiceDate: string; fiscalYear: string; totalPaisa: number; notes: string | null; userId: number; isDemo: number }): number {
    const now = this.ctx.clock.now().toISOString();
    const res = this.ctx.db
      .prepare(
        `INSERT INTO purchases (purchase_no, supplier_id, invoice_no, invoice_date, fiscal_year, total_paisa, notes, received_at, received_by, is_demo, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(p.purchaseNo, p.supplierId, p.invoiceNo, p.invoiceDate, p.fiscalYear, p.totalPaisa, p.notes, now, p.userId, p.isDemo, now);
    return Number(res.lastInsertRowid);
  }

  insertItem(i: { purchaseId: number; productId: number; quantity: number; unitCostPaisa: number; batchNo: string | null; expiryDate: string | null }): number {
    const res = this.ctx.db
      .prepare('INSERT INTO purchase_items (purchase_id, product_id, quantity, unit_cost_paisa, line_total_paisa, batch_no, expiry_date) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(i.purchaseId, i.productId, i.quantity, i.unitCostPaisa, i.quantity * i.unitCostPaisa, i.batchNo, i.expiryDate);
    return Number(res.lastInsertRowid);
  }

  list(f: { page: number; pageSize: number; fiscalYear?: string }): Page<PurchaseSummary> {
    const w = f.fiscalYear ? 'WHERE pu.fiscal_year = ?' : '';
    const params = f.fiscalYear ? [f.fiscalYear] : [];
    const total = (this.ctx.db.prepare(`SELECT COUNT(*) n FROM purchases pu ${w}`).get(...params) as { n: number }).n;
    const rows = this.ctx.db.prepare(`${PURCHASE_SELECT} ${w} ORDER BY pu.id DESC LIMIT ? OFFSET ?`).all(...params, f.pageSize, (f.page - 1) * f.pageSize) as Record<string, unknown>[];
    return { rows: rows.map(mapPurchase), total, page: f.page, pageSize: f.pageSize };
  }

  detail(id: number): PurchaseDetail | null {
    const r = this.ctx.db.prepare(`${PURCHASE_SELECT} WHERE pu.id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!r) return null;
    const items = (
      this.ctx.db.prepare('SELECT pi.*, p.sku, p.name FROM purchase_items pi JOIN products p ON p.id = pi.product_id WHERE pi.purchase_id = ? ORDER BY pi.id').all(id) as Record<
        string,
        unknown
      >[]
    ).map((i) => ({
      id: i.id as number,
      productId: i.product_id as number,
      sku: i.sku as string,
      name: i.name as string,
      quantity: i.quantity as number,
      unitCostPaisa: i.unit_cost_paisa as number,
      lineTotalPaisa: i.line_total_paisa as number,
      batchNo: (i.batch_no as string) ?? null,
      expiryDate: (i.expiry_date as string) ?? null,
    }));
    return { ...mapPurchase(r), notes: (r.notes as string) ?? null, items };
  }
}
