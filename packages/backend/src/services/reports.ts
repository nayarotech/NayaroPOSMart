import type { DashboardSummary, PurchaseReport, ReturnsReport, SalesReport, SalesTotals, StockValuation } from '@srmart/shared';
import { BS_MONTHS, dateRangeSchema, parseLocalISODate, salesReportSchema, toBsDate, toLocalISODate } from '@srmart/shared';
import type { Ctx } from '../context';
import { businessDate } from '../clock';
import { invalid } from '../errors';
import { ProductRepo } from '../repositories/productRepo';
import { SaleRepo } from '../repositories/saleRepo';
import { SettingsRepo } from '../repositories/settingsRepo';
import { StockRepo } from '../repositories/stockRepo';
import { FiscalService } from './fiscal';

interface DayRow {
  date: string;
  sales_count: number;
  gross: number;
  disc: number;
  tax: number;
  net: number;
  refunds: number;
  cogs: number;
  kept_net: number;
}

const emptyTotals = (): SalesTotals => ({
  salesCount: 0,
  grossSalesPaisa: 0,
  discountPaisa: 0,
  taxPaisa: 0,
  netSalesPaisa: 0,
  refundsPaisa: 0,
  costOfGoodsPaisa: 0,
  estimatedMarginPaisa: 0,
  estimatedMarginBp: 0,
});

function addDay(t: SalesTotals, d: DayRow, keptNetAcc: { v: number }) {
  t.salesCount += d.sales_count;
  t.grossSalesPaisa += d.gross;
  t.discountPaisa += d.disc;
  t.taxPaisa += d.tax;
  t.netSalesPaisa += d.net;
  t.refundsPaisa += d.refunds;
  t.costOfGoodsPaisa += d.cogs;
  keptNetAcc.v += d.kept_net;
}

function finish(t: SalesTotals, keptNet: number): SalesTotals {
  const kept = Math.round(keptNet);
  t.estimatedMarginPaisa = kept - t.costOfGoodsPaisa;
  t.estimatedMarginBp = kept > 0 ? Math.round((t.estimatedMarginPaisa * 10000) / kept) : 0;
  return t;
}

function addDays(iso: string, n: number) {
  const d = parseLocalISODate(iso);
  d.setDate(d.getDate() + n);
  return toLocalISODate(d);
}

/**
 * All revenue figures exclude voided sales. "Estimated gross margin" = net sales of items not
 * returned minus the cost price recorded at the time of sale. It is NOT profit: it ignores
 * rent, wages, wastage, supplier discounts and taxes.
 */
export class ReportService {
  private products: ProductRepo;
  private sales: SaleRepo;
  private stock: StockRepo;
  private settings: SettingsRepo;
  private fiscal: FiscalService;

  constructor(private ctx: Ctx) {
    this.products = new ProductRepo(ctx);
    this.sales = new SaleRepo(ctx);
    this.stock = new StockRepo(ctx);
    this.settings = new SettingsRepo(ctx);
    this.fiscal = new FiscalService(ctx);
  }

  private dayRows(from: string, to: string): DayRow[] {
    return this.ctx.db
      .prepare(
        `WITH s AS (SELECT * FROM sales WHERE business_date BETWEEN ? AND ? AND status != 'voided'),
         head AS (SELECT business_date AS date, COUNT(*) sales_count, SUM(subtotal_paisa) gross, SUM(discount_paisa) disc,
                    SUM(tax_paisa) tax, SUM(total_paisa - tax_paisa) net FROM s GROUP BY business_date),
         ref AS (SELECT s.business_date AS date, SUM(r.refund_paisa) refunds FROM sales_returns r JOIN s ON s.id = r.sale_id GROUP BY s.business_date),
         items AS (SELECT s.business_date AS date,
                    SUM(si.unit_cost_paisa * (si.quantity - si.returned_quantity)) cogs,
                    SUM(si.line_total_paisa * 1.0 * (si.quantity - si.returned_quantity) / si.quantity) kept_net
                   FROM sale_items si JOIN s ON s.id = si.sale_id GROUP BY s.business_date)
         SELECT head.*, COALESCE(ref.refunds, 0) refunds, COALESCE(items.cogs, 0) cogs, COALESCE(items.kept_net, 0) kept_net
         FROM head LEFT JOIN ref ON ref.date = head.date LEFT JOIN items ON items.date = head.date ORDER BY head.date`,
      )
      .all(from, to) as DayRow[];
  }

  totals(from: string, to: string): SalesTotals {
    const t = emptyTotals();
    const acc = { v: 0 };
    for (const d of this.dayRows(from, to)) addDay(t, d, acc);
    return finish(t, acc.v);
  }

  salesReport(input: unknown): SalesReport {
    const r = salesReportSchema.parse(input);
    if (r.from > r.to) throw invalid('"From" date must be before "to" date');
    const days = this.dayRows(r.from, r.to);
    const buckets = new Map<string, { key: string; label: string; t: SalesTotals; acc: { v: number } }>();
    const keyFor = (date: string): { key: string; label: string } => {
      const d = parseLocalISODate(date);
      if (r.groupBy === 'day') return { key: date, label: `${date} (${toBsDate(d).text} BS)` };
      if (r.groupBy === 'week') {
        const start = new Date(d);
        start.setDate(d.getDate() - d.getDay()); // weeks start on Sunday in Nepal
        const s = toLocalISODate(start);
        return { key: s, label: `Week of ${s}` };
      }
      const bs = toBsDate(d);
      return { key: `${bs.year}-${String(bs.month).padStart(2, '0')}`, label: `${BS_MONTHS[bs.month - 1]} ${bs.year}` };
    };
    for (const d of days) {
      const k = keyFor(d.date);
      const b = buckets.get(k.key) ?? { ...k, t: emptyTotals(), acc: { v: 0 } };
      addDay(b.t, d, b.acc);
      buckets.set(k.key, b);
    }
    const totals = emptyTotals();
    const acc = { v: 0 };
    for (const d of days) addDay(totals, d, acc);

    const payments = (
      this.ctx.db
        .prepare(
          `SELECT p.method, p.kind, COUNT(*) count, SUM(p.amount_paisa) amount FROM payments p JOIN sales s ON s.id = p.sale_id
           WHERE s.business_date BETWEEN ? AND ? GROUP BY p.method, p.kind ORDER BY p.kind, amount DESC`,
        )
        .all(r.from, r.to) as { method: string; kind: 'payment' | 'refund'; count: number; amount: number }[]
    ).map((p) => ({ method: p.method, kind: p.kind, count: p.count, amountPaisa: p.amount }));

    const topProducts = (
      this.ctx.db
        .prepare(
          `SELECT si.product_id, si.name, SUM(si.quantity - si.returned_quantity) qty,
             SUM(si.line_total_paisa * 1.0 * (si.quantity - si.returned_quantity) / si.quantity) net,
             SUM(si.unit_cost_paisa * (si.quantity - si.returned_quantity)) cogs
           FROM sale_items si JOIN sales s ON s.id = si.sale_id
           WHERE s.business_date BETWEEN ? AND ? AND s.status != 'voided'
           GROUP BY si.product_id ORDER BY net DESC LIMIT 10`,
        )
        .all(r.from, r.to) as { product_id: number; name: string; qty: number; net: number; cogs: number }[]
    ).map((x) => ({ productId: x.product_id, name: x.name, quantity: x.qty, netPaisa: Math.round(x.net), estimatedMarginPaisa: Math.round(x.net) - x.cogs }));

    const byCategory = (
      this.ctx.db
        .prepare(
          `SELECT COALESCE(c.name, 'Uncategorised') category, SUM(si.quantity - si.returned_quantity) qty,
             SUM(si.line_total_paisa * 1.0 * (si.quantity - si.returned_quantity) / si.quantity) net
           FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN products p ON p.id = si.product_id LEFT JOIN categories c ON c.id = p.category_id
           WHERE s.business_date BETWEEN ? AND ? AND s.status != 'voided'
           GROUP BY category ORDER BY net DESC`,
        )
        .all(r.from, r.to) as { category: string; qty: number; net: number }[]
    ).map((x) => ({ category: x.category, quantity: x.qty, netPaisa: Math.round(x.net) }));

    const promotions = (
      this.ctx.db
        .prepare(
          `SELECT si.promotion_name name, COUNT(*) lines, SUM(si.promo_discount_paisa) disc FROM sale_items si JOIN sales s ON s.id = si.sale_id
           WHERE s.business_date BETWEEN ? AND ? AND s.status != 'voided' AND si.promo_discount_paisa > 0 GROUP BY si.promotion_name ORDER BY disc DESC`,
        )
        .all(r.from, r.to) as { name: string; lines: number; disc: number }[]
    ).map((x) => ({ name: x.name, lines: x.lines, discountPaisa: x.disc }));

    return {
      from: r.from,
      to: r.to,
      groupBy: r.groupBy,
      promotions,
      totals: finish(totals, acc.v),
      buckets: [...buckets.values()].map((b) => ({ key: b.key, label: b.label, ...finish(b.t, b.acc.v) })),
      payments,
      topProducts,
      byCategory,
    };
  }

  stockValuation(): StockValuation {
    const rows = this.ctx.db
      .prepare(
        `SELECT COALESCE(c.name, 'Uncategorised') category, COUNT(*) products, SUM(p.qty_on_hand) units,
           SUM(p.qty_on_hand * p.cost_paisa) cost, SUM(p.qty_on_hand * p.price_paisa) retail
         FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.active = 1 AND p.qty_on_hand > 0
         GROUP BY category ORDER BY cost DESC`,
      )
      .all() as { category: string; products: number; units: number; cost: number; retail: number }[];
    return {
      products: rows.reduce((a, r) => a + r.products, 0),
      units: rows.reduce((a, r) => a + r.units, 0),
      costValuePaisa: rows.reduce((a, r) => a + r.cost, 0),
      retailValuePaisa: rows.reduce((a, r) => a + r.retail, 0),
      byCategory: rows.map((r) => ({ category: r.category, units: r.units, costValuePaisa: r.cost, retailValuePaisa: r.retail })),
    };
  }

  purchases(input: unknown): PurchaseReport {
    const r = dateRangeSchema.parse(input);
    const rows = this.ctx.db
      .prepare(
        `SELECT s.name supplier, COUNT(*) count, SUM(p.total_paisa) total FROM purchases p JOIN suppliers s ON s.id = p.supplier_id
         WHERE p.invoice_date BETWEEN ? AND ? GROUP BY s.id ORDER BY total DESC`,
      )
      .all(r.from, r.to) as { supplier: string; count: number; total: number }[];
    return {
      from: r.from,
      to: r.to,
      count: rows.reduce((a, x) => a + x.count, 0),
      totalPaisa: rows.reduce((a, x) => a + x.total, 0),
      bySupplier: rows.map((x) => ({ supplier: x.supplier, count: x.count, totalPaisa: x.total })),
    };
  }

  returns(input: unknown): ReturnsReport {
    const r = dateRangeSchema.parse(input);
    const rows = this.ctx.db
      .prepare(
        `SELECT r.return_no, s.receipt_no, r.reason, r.refund_paisa, r.created_at, u.full_name created_by
         FROM sales_returns r JOIN sales s ON s.id = r.sale_id JOIN users u ON u.id = r.created_by
         WHERE r.business_date BETWEEN ? AND ? ORDER BY r.id DESC`,
      )
      .all(r.from, r.to) as { return_no: string; receipt_no: string; reason: string; refund_paisa: number; created_at: string; created_by: string }[];
    const voids = this.ctx.db
      .prepare("SELECT COUNT(*) n, COALESCE(SUM(total_paisa), 0) total FROM sales WHERE status = 'voided' AND date(voided_at, 'localtime') BETWEEN ? AND ?")
      .get(r.from, r.to) as { n: number; total: number };
    return {
      from: r.from,
      to: r.to,
      count: rows.length,
      refundPaisa: rows.reduce((a, x) => a + x.refund_paisa, 0),
      voidCount: voids.n,
      voidPaisa: voids.total,
      rows: rows.map((x) => ({ returnNo: x.return_no, receiptNo: x.receipt_no, reason: x.reason, refundPaisa: x.refund_paisa, createdAt: x.created_at, createdBy: x.created_by })),
    };
  }

  dashboard(): DashboardSummary {
    const fiscal = this.fiscal.current();
    const today = businessDate(this.ctx.clock);
    const counts = this.ctx.db
      .prepare("SELECT SUM(is_demo = 1) demo, SUM(is_demo = 0) real FROM sales WHERE business_date = ? AND status != 'voided'")
      .get(today) as { demo: number | null; real: number | null };
    const weekStart = addDays(today, -6);
    const daily = new Map(this.dayRows(weekStart, today).map((d) => [d.date, d]));
    const last7Days = Array.from({ length: 7 }, (_, i) => {
      const date = addDays(weekStart, i);
      const d = daily.get(date);
      return { date, netSalesPaisa: d?.net ?? 0, salesCount: d?.sales_count ?? 0 };
    });
    const lowStock = this.products.lowStock(8);
    return {
      fiscal,
      dataMode: this.settings.getDataMode(),
      today: { ...this.totals(today, today), demoSalesCount: counts.demo ?? 0, realSalesCount: counts.real ?? 0 },
      fiscalYearToDate: this.totals(fiscal.startDate, today),
      last7Days,
      lowStock,
      lowStockCount: this.products.countLowStock(),
      recent: this.sales.list({ status: 'all', page: 1, pageSize: 8 }).rows,
      outdatedLabelCount: this.products.countOutdatedLabels(),
      expiringSoonCount: this.stock.expiring(30, today).length,
    };
  }
}
