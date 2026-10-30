import type { Page, Payment, SaleDetail, SaleItem, SaleReturn, SaleStatus, SaleSummary } from '@srmart/shared';
import { toBsDate, parseLocalISODate } from '@srmart/shared';
import type { Ctx } from '../context';
import { bool } from '../db/database';
import { businessDate } from '../clock';

const SUMMARY_SELECT = `
  SELECT s.*, u.full_name AS cashier_name,
    (SELECT COALESCE(SUM(quantity), 0) FROM sale_items si WHERE si.sale_id = s.id) AS item_count,
    (SELECT COALESCE(SUM(refund_paisa), 0) FROM sales_returns r WHERE r.sale_id = s.id) AS refunded_paisa,
    (SELECT method FROM payments p WHERE p.sale_id = s.id AND p.kind = 'payment' ORDER BY p.id LIMIT 1) AS payment_method
  FROM sales s JOIN users u ON u.id = s.cashier_id`;

function mapSummary(r: Record<string, unknown>): SaleSummary {
  return {
    id: r.id as number,
    receiptNo: r.receipt_no as string,
    fiscalYear: r.fiscal_year as string,
    businessDate: r.business_date as string,
    createdAt: r.created_at as string,
    cashierName: r.cashier_name as string,
    itemCount: r.item_count as number,
    totalPaisa: r.total_paisa as number,
    refundedPaisa: (r.refunded_paisa as number) + (r.status === 'voided' ? (r.total_paisa as number) : 0),
    status: r.status as SaleStatus,
    paymentMethod: (r.payment_method as string) ?? 'cash',
    isDemo: bool(r.is_demo),
  };
}

export interface SaleFilter {
  from?: string;
  to?: string;
  fiscalYear?: string;
  status: 'all' | SaleStatus;
  q?: string;
  page: number;
  pageSize: number;
}

export interface NewSale {
  receiptNo: string;
  clientTxnId: string;
  fiscalYear: string;
  businessDate: string;
  cashierId: number;
  customerName: string | null;
  subtotalPaisa: number;
  discountPaisa: number;
  orderDiscountPaisa: number;
  taxPaisa: number;
  taxLabel: string | null;
  taxRateBp: number;
  taxInclusive: boolean;
  totalPaisa: number;
  discountApprovedBy: number | null;
  isDemo: number;
  customerId: number | null;
  promoDiscountPaisa: number;
}

export interface NewSaleItem {
  saleId: number;
  productId: number;
  sku: string;
  name: string;
  unit: string;
  quantity: number;
  unitPricePaisa: number;
  unitCostPaisa: number;
  discountPaisa: number;
  lineTotalPaisa: number;
  taxPaisa: number;
  grossPaisa: number;
  promoDiscountPaisa: number;
  promotionId: number | null;
  promotionName: string | null;
}

export interface RawSaleItem extends SaleItem {
  grossPaisa: number;
  taxPaisa: number;
}

export class SaleRepo {
  constructor(private ctx: Ctx) {}

  idByClientTxn(clientTxnId: string): number | null {
    const r = this.ctx.db.prepare('SELECT id FROM sales WHERE client_txn_id = ?').get(clientTxnId) as { id: number } | undefined;
    return r?.id ?? null;
  }

  insertSale(s: NewSale): number {
    const res = this.ctx.db
      .prepare(
        `INSERT INTO sales (receipt_no, client_txn_id, fiscal_year, business_date, cashier_id, customer_name, subtotal_paisa, discount_paisa,
           order_discount_paisa, tax_paisa, tax_label, tax_rate_bp, tax_inclusive, total_paisa, status, discount_approved_by, is_demo, created_at,
           customer_id, promo_discount_paisa)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?)`,
      )
      .run(
        s.receiptNo, s.clientTxnId, s.fiscalYear, s.businessDate, s.cashierId, s.customerName, s.subtotalPaisa, s.discountPaisa,
        s.orderDiscountPaisa, s.taxPaisa, s.taxLabel, s.taxRateBp, s.taxInclusive ? 1 : 0, s.totalPaisa, s.discountApprovedBy, s.isDemo,
        this.ctx.clock.now().toISOString(), s.customerId, s.promoDiscountPaisa,
      );
    return Number(res.lastInsertRowid);
  }

  insertItem(i: NewSaleItem): number {
    const res = this.ctx.db
      .prepare(
        `INSERT INTO sale_items (sale_id, product_id, sku, name, unit, quantity, unit_price_paisa, unit_cost_paisa, discount_paisa, line_total_paisa, tax_paisa, gross_paisa,
           promo_discount_paisa, promotion_id, promotion_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(i.saleId, i.productId, i.sku, i.name, i.unit, i.quantity, i.unitPricePaisa, i.unitCostPaisa, i.discountPaisa, i.lineTotalPaisa, i.taxPaisa, i.grossPaisa, i.promoDiscountPaisa, i.promotionId, i.promotionName);
    return Number(res.lastInsertRowid);
  }

  insertPayment(p: { saleId: number; returnId: number | null; kind: 'payment' | 'refund'; method: string; amountPaisa: number; tenderedPaisa: number | null; changePaisa: number | null; reference: string | null; userId: number; isDemo: number }) {
    this.ctx.db
      .prepare(
        `INSERT INTO payments (sale_id, return_id, kind, method, amount_paisa, tendered_paisa, change_paisa, reference, created_by, is_demo, created_at, business_date, shift_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT id FROM cash_shifts WHERE closed_at IS NULL))`,
      )
      .run(p.saleId, p.returnId, p.kind, p.method, p.amountPaisa, p.tenderedPaisa, p.changePaisa, p.reference, p.userId, p.isDemo, this.ctx.clock.now().toISOString(), businessDate(this.ctx.clock));
  }

  setStatus(id: number, status: SaleStatus) {
    this.ctx.db.prepare('UPDATE sales SET status = ? WHERE id = ?').run(status, id);
  }

  markVoided(id: number, userId: number, reason: string) {
    this.ctx.db
      .prepare("UPDATE sales SET status = 'voided', voided_at = ?, voided_by = ?, void_reason = ? WHERE id = ? AND status = 'completed'")
      .run(this.ctx.clock.now().toISOString(), userId, reason, id);
  }

  addReturnedQty(saleItemId: number, qty: number) {
    this.ctx.db.prepare('UPDATE sale_items SET returned_quantity = returned_quantity + ? WHERE id = ?').run(qty, saleItemId);
  }

  insertReturn(r: { returnNo: string; saleId: number; fiscalYear: string; businessDate: string; reason: string; restock: boolean; refundPaisa: number; createdBy: number; approvedBy: number | null; isDemo: number }): number {
    const res = this.ctx.db
      .prepare(
        `INSERT INTO sales_returns (return_no, sale_id, fiscal_year, business_date, reason, restock, refund_paisa, created_by, approved_by, is_demo, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.returnNo, r.saleId, r.fiscalYear, r.businessDate, r.reason, r.restock ? 1 : 0, r.refundPaisa, r.createdBy, r.approvedBy, r.isDemo, this.ctx.clock.now().toISOString());
    return Number(res.lastInsertRowid);
  }

  insertReturnItem(returnId: number, saleItemId: number, qty: number, refund: number): number {
    const res = this.ctx.db
      .prepare('INSERT INTO sales_return_items (return_id, sale_item_id, quantity, refund_paisa) VALUES (?, ?, ?, ?)')
      .run(returnId, saleItemId, qty, refund);
    return Number(res.lastInsertRowid);
  }

  items(saleId: number): RawSaleItem[] {
    return (this.ctx.db.prepare('SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id').all(saleId) as Record<string, unknown>[]).map((r) => ({
      id: r.id as number,
      productId: r.product_id as number,
      sku: r.sku as string,
      name: r.name as string,
      unit: r.unit as string,
      quantity: r.quantity as number,
      returnedQuantity: r.returned_quantity as number,
      unitPricePaisa: r.unit_price_paisa as number,
      unitCostPaisa: r.unit_cost_paisa as number,
      discountPaisa: r.discount_paisa as number,
      lineTotalPaisa: r.line_total_paisa as number,
      taxPaisa: r.tax_paisa as number,
      grossPaisa: r.gross_paisa as number,
      promoDiscountPaisa: (r.promo_discount_paisa as number) ?? 0,
      promotionName: (r.promotion_name as string) ?? null,
    }));
  }

  summary(id: number): SaleSummary | null {
    const r = this.ctx.db.prepare(`${SUMMARY_SELECT} WHERE s.id = ?`).get(id) as Record<string, unknown> | undefined;
    return r ? mapSummary(r) : null;
  }

  detail(id: number): SaleDetail | null {
    const r = this.ctx.db
      .prepare(
        `${SUMMARY_SELECT.replace('FROM sales s', ', ap.full_name AS approved_name, vu.full_name AS voided_name FROM sales s')}
         LEFT JOIN users ap ON ap.id = s.discount_approved_by LEFT JOIN users vu ON vu.id = s.voided_by WHERE s.id = ?`.replace(
          ', ap.full_name AS approved_name',
          ', ap.full_name AS approved_name, (SELECT name FROM customers c WHERE c.id = s.customer_id) AS cust_name, (SELECT phone FROM customers c WHERE c.id = s.customer_id) AS cust_phone',
        ),
      )
      .get(id) as Record<string, unknown> | undefined;
    if (!r) return null;
    const payments = (this.ctx.db.prepare('SELECT * FROM payments WHERE sale_id = ? ORDER BY id').all(id) as Record<string, unknown>[]).map(
      (p): Payment => ({
        id: p.id as number,
        method: p.method as string,
        kind: p.kind as 'payment' | 'refund',
        amountPaisa: p.amount_paisa as number,
        tenderedPaisa: (p.tendered_paisa as number) ?? null,
        changePaisa: (p.change_paisa as number) ?? null,
        reference: (p.reference as string) ?? null,
        createdAt: p.created_at as string,
      }),
    );
    const returns = (
      this.ctx.db
        .prepare(
          `SELECT r.*, u.full_name AS created_name, ap.full_name AS approved_name FROM sales_returns r
           JOIN users u ON u.id = r.created_by LEFT JOIN users ap ON ap.id = r.approved_by WHERE r.sale_id = ? ORDER BY r.id`,
        )
        .all(id) as Record<string, unknown>[]
    ).map(
      (x): SaleReturn => ({
        id: x.id as number,
        returnNo: x.return_no as string,
        reason: x.reason as string,
        restock: bool(x.restock),
        refundPaisa: x.refund_paisa as number,
        createdAt: x.created_at as string,
        createdBy: x.created_name as string,
        approvedBy: (x.approved_name as string) ?? null,
        items: (
          this.ctx.db
            .prepare('SELECT ri.*, si.name FROM sales_return_items ri JOIN sale_items si ON si.id = ri.sale_item_id WHERE ri.return_id = ?')
            .all(x.id) as Record<string, unknown>[]
        ).map((ri) => ({ saleItemId: ri.sale_item_id as number, name: ri.name as string, quantity: ri.quantity as number, refundPaisa: ri.refund_paisa as number })),
      }),
    );
    const items = this.items(id).map(({ grossPaisa: _g, taxPaisa: _t, ...i }) => i);
    return {
      ...mapSummary(r),
      subtotalPaisa: r.subtotal_paisa as number,
      discountPaisa: r.discount_paisa as number,
      taxPaisa: r.tax_paisa as number,
      taxLabel: (r.tax_label as string) ?? null,
      taxRateBp: r.tax_rate_bp as number,
      taxInclusive: bool(r.tax_inclusive),
      customerName: (r.customer_name as string) ?? null,
      bsDate: toBsDate(parseLocalISODate(r.business_date as string)).text,
      items,
      payments,
      returns,
      voidReason: (r.void_reason as string) ?? null,
      voidedAt: (r.voided_at as string) ?? null,
      voidedBy: (r.voided_name as string) ?? null,
      discountApprovedBy: (r.approved_name as string) ?? null,
      promoDiscountPaisa: (r.promo_discount_paisa as number) ?? 0,
      customer: r.customer_id ? { id: r.customer_id as number, name: r.cust_name as string, phone: r.cust_phone as string } : null,
      coupons: (
        this.ctx.db
          .prepare('SELECT e.coupon_no, sc.name FROM scheme_entries e JOIN schemes sc ON sc.id = e.scheme_id WHERE e.sale_id = ? ORDER BY e.id')
          .all(id) as { coupon_no: string; name: string }[]
      ).map((x) => ({ couponNo: x.coupon_no, schemeName: x.name, eligible: r.status === 'completed' || r.status === 'partially_returned' })),
    };
  }

  list(f: SaleFilter): Page<SaleSummary> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (f.from) {
      where.push('s.business_date >= ?');
      params.push(f.from);
    }
    if (f.to) {
      where.push('s.business_date <= ?');
      params.push(f.to);
    }
    if (f.fiscalYear) {
      where.push('s.fiscal_year = ?');
      params.push(f.fiscalYear);
    }
    if (f.status !== 'all') {
      where.push('s.status = ?');
      params.push(f.status);
    }
    if (f.q) {
      where.push('(s.receipt_no LIKE ? OR s.customer_name LIKE ?)');
      params.push(`%${f.q}%`, `%${f.q}%`);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (this.ctx.db.prepare(`SELECT COUNT(*) n FROM sales s ${w}`).get(...params) as { n: number }).n;
    const rows = this.ctx.db.prepare(`${SUMMARY_SELECT} ${w} ORDER BY s.id DESC LIMIT ? OFFSET ?`).all(...params, f.pageSize, (f.page - 1) * f.pageSize) as Record<string, unknown>[];
    return { rows: rows.map(mapSummary), total, page: f.page, pageSize: f.pageSize };
  }
}
