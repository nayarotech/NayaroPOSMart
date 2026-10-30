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

// Immutable sale snapshots plus dated reversals keep closed periods stable.
// Cumulative allocation matches refund rounding, including repeated partial returns.
const ACTIVITY = `WITH returned AS (
  SELECT ri.*, r.business_date, r.restock, si.product_id, si.name, si.quantity sold_qty,
    si.line_total_paisa, si.unit_cost_paisa, si.promo_discount_paisa,
    COALESCE((SELECT SUM(prev.quantity) FROM sales_return_items prev
      WHERE prev.sale_item_id = ri.sale_item_id AND prev.id < ri.id), 0) prior_qty
  FROM sales_return_items ri JOIN sales_returns r ON r.id = ri.return_id
  JOIN sale_items si ON si.id = ri.sale_item_id
), activity AS (
  SELECT s.business_date date, si.product_id, si.name, si.quantity qty,
    si.unit_price_paisa * si.quantity gross, si.discount_paisa disc, si.tax_paisa tax,
    si.line_total_paisa net, 0 refund, si.unit_cost_paisa * si.quantity cogs,
    si.promotion_name, si.promo_discount_paisa promo
  FROM sale_items si JOIN sales s ON s.id = si.sale_id
  UNION ALL
  SELECT business_date, product_id, name, -quantity, 0, 0,
    -(refund_paisa - (ROUND(line_total_paisa * 1.0 * (prior_qty + quantity) / sold_qty) - ROUND(line_total_paisa * 1.0 * prior_qty / sold_qty))),
    -(ROUND(line_total_paisa * 1.0 * (prior_qty + quantity) / sold_qty) - ROUND(line_total_paisa * 1.0 * prior_qty / sold_qty)),
    refund_paisa, CASE WHEN restock = 1 THEN -unit_cost_paisa * quantity ELSE 0 END,
    NULL, 0 FROM returned
  UNION ALL
  SELECT p.business_date, si.product_id, si.name, -si.quantity,
    -si.unit_price_paisa * si.quantity, -si.discount_paisa, -si.tax_paisa,
    -si.line_total_paisa, si.gross_paisa, -si.unit_cost_paisa * si.quantity,
    si.promotion_name, -si.promo_discount_paisa
  FROM sale_items si JOIN sales s ON s.id = si.sale_id
  JOIN payments p ON p.sale_id = s.id AND p.kind = 'refund' AND p.return_id IS NULL
  WHERE s.status = 'voided'
)`;

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
 * Activity is dated when it occurs: sales, returns and void reversals.
 * Estimated gross margin subtracts recorded costs; only restocked returns reverse costs. It is NOT profit: it ignores
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
    return this.ctx.db.prepare(`${ACTIVITY},
      dates AS (SELECT date FROM activity WHERE date BETWEEN :from AND :to
                UNION SELECT business_date FROM sales WHERE business_date BETWEEN :from AND :to),
      counts AS (SELECT business_date date, COUNT(*) n FROM sales GROUP BY business_date),
      amounts AS (SELECT date, SUM(gross) gross, SUM(disc) disc, SUM(tax) tax,
        SUM(net) net, SUM(refund) refunds, SUM(cogs) cogs FROM activity GROUP BY date)
      SELECT d.date, COALESCE(c.n, 0) sales_count, COALESCE(a.gross, 0) gross,
        COALESCE(a.disc, 0) disc, COALESCE(a.tax, 0) tax, COALESCE(a.net, 0) net,
        COALESCE(a.refunds, 0) refunds, COALESCE(a.cogs, 0) cogs, COALESCE(a.net, 0) kept_net
      FROM dates d LEFT JOIN counts c ON c.date = d.date LEFT JOIN amounts a ON a.date = d.date
      ORDER BY d.date`).all({ from, to }) as DayRow[];
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
          `SELECT p.method, p.kind, COUNT(*) count, SUM(p.amount_paisa) amount FROM payments p
           WHERE p.business_date BETWEEN ? AND ? GROUP BY p.method, p.kind ORDER BY p.kind, amount DESC`,
        )
        .all(r.from, r.to) as { method: string; kind: 'payment' | 'refund'; count: number; amount: number }[]
    ).map((p) => ({ method: p.method, kind: p.kind, count: p.count, amountPaisa: p.amount }));

    const topProducts = (this.ctx.db.prepare(`${ACTIVITY}
      SELECT product_id, MAX(name) name, SUM(qty) qty, SUM(net) net, SUM(cogs) cogs
      FROM activity WHERE date BETWEEN ? AND ? GROUP BY product_id ORDER BY net DESC LIMIT 10`)
      .all(r.from, r.to) as { product_id: number; name: string; qty: number; net: number; cogs: number }[])
      .map((x) => ({ productId: x.product_id, name: x.name, quantity: x.qty, netPaisa: x.net, estimatedMarginPaisa: x.net - x.cogs }));

    const byCategory = (this.ctx.db.prepare(`${ACTIVITY}
      SELECT COALESCE(c.name, 'Uncategorised') category, SUM(a.qty) qty, SUM(a.net) net
      FROM activity a JOIN products p ON p.id = a.product_id LEFT JOIN categories c ON c.id = p.category_id
      WHERE a.date BETWEEN ? AND ? GROUP BY category ORDER BY net DESC`)
      .all(r.from, r.to) as { category: string; qty: number; net: number }[])
      .map((x) => ({ category: x.category, quantity: x.qty, netPaisa: x.net }));

    const promotions = (this.ctx.db.prepare(`${ACTIVITY}
      SELECT promotion_name name, SUM(CASE WHEN promo > 0 THEN 1 ELSE -1 END) lines, SUM(promo) disc
      FROM activity WHERE date BETWEEN ? AND ? AND promo != 0 GROUP BY promotion_name ORDER BY disc DESC`)
      .all(r.from, r.to) as { name: string; lines: number; disc: number }[])
      .map((x) => ({ name: x.name, lines: x.lines, discountPaisa: x.disc }));

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
      .prepare("SELECT SUM(is_demo = 1) demo, SUM(is_demo = 0) real FROM sales WHERE business_date = ?")
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
