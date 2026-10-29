import type { QuoteLine, SaleDetail, SaleQuote, SessionUser } from '@srmart/shared';
import { completeSaleSchema, returnSchema, saleQuoteSchema, salesQuerySchema, voidSaleSchema } from '@srmart/shared';
import type { Ctx } from '../context';
import { businessDate } from '../clock';
import { tx } from '../db/database';
import { AppError, forbidden, invalid, notFound } from '../errors';
import { AuditRepo } from '../repositories/auditRepo';
import { ProductRepo } from '../repositories/productRepo';
import { SaleRepo } from '../repositories/saleRepo';
import { SequenceRepo } from '../repositories/sequenceRepo';
import { SettingsRepo } from '../repositories/settingsRepo';
import { StockRepo } from '../repositories/stockRepo';
import { AuthService } from './auth';
import { FiscalService } from './fiscal';
import { Outbox } from './outbox';
import { bestPromotion, PromotionService } from './promotions';

/** Splits `amount` across `weights` proportionally using the largest-remainder method (sums exactly). */
export function allocate(amount: number, weights: number[]): number[] {
  const total = weights.reduce((a, b) => a + b, 0);
  if (amount === 0 || total === 0) return weights.map(() => 0);
  const raw = weights.map((w) => (amount * w) / total);
  const floors = raw.map(Math.floor);
  let rest = amount - floors.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac);
  for (const { i } of order) {
    if (rest <= 0) break;
    floors[i]! += 1;
    rest -= 1;
  }
  return floors;
}

/** Refund for returning cumulative quantity q out of n, computed on cumulative totals so rounding never over-refunds. */
export const cumulativeShare = (gross: number, q: number, n: number) => Math.round((gross * q) / n);

export const fiscalShort = (code: string) => code.slice(2).replace('/', '-'); // "2083/84" -> "83-84"

export class SalesService {
  private products: ProductRepo;
  private sales: SaleRepo;
  private stock: StockRepo;
  private seq: SequenceRepo;
  private audit: AuditRepo;
  private settings: SettingsRepo;
  private fiscal: FiscalService;
  private outbox: Outbox;
  private promos: PromotionService;

  constructor(private ctx: Ctx, private auth: AuthService) {
    this.promos = new PromotionService(ctx);
    this.products = new ProductRepo(ctx);
    this.sales = new SaleRepo(ctx);
    this.stock = new StockRepo(ctx);
    this.seq = new SequenceRepo(ctx);
    this.audit = new AuditRepo(ctx);
    this.settings = new SettingsRepo(ctx);
    this.fiscal = new FiscalService(ctx);
    this.outbox = new Outbox(ctx);
  }

  /** Authoritative pricing from the database. Renderer prices are never trusted. */
  quote(user: SessionUser, input: unknown): SaleQuote {
    const q = saleQuoteSchema.parse(input);
    const settings = this.settings.getSettings();

    // Merge duplicate product lines so one product appears once.
    const merged = new Map<number, { quantity: number; discountPaisa: number }>();
    for (const l of q.lines) {
      const m = merged.get(l.productId) ?? { quantity: 0, discountPaisa: 0 };
      m.quantity += l.quantity;
      m.discountPaisa += l.discountPaisa;
      merged.set(l.productId, m);
    }
    const products = new Map(this.products.byIds([...merged.keys()]).map((p) => [p.id, p]));
    const promos = this.promos.repo.activePromotions(businessDate(this.ctx.clock));
    const warnings: string[] = [];
    const lines: QuoteLine[] = [];
    for (const [productId, l] of merged) {
      const p = products.get(productId);
      if (!p) throw notFound(`Product #${productId}`);
      if (!p.active) throw invalid(`${p.name} is disabled and cannot be sold`);
      const lineSubtotal = p.pricePaisa * l.quantity;
      // Festival promotions apply automatically first; manual discounts come on top of what remains.
      const promo = bestPromotion(promos, p.categoryId);
      const promoDiscount = promo ? Math.round((lineSubtotal * promo.percentBp) / 10000) : 0;
      if (l.discountPaisa > lineSubtotal - promoDiscount) throw invalid(`Discount on ${p.name} is larger than the line amount`);
      if (l.quantity > p.qtyOnHand) {
        if (!settings.pos.allowNegativeStock) {
          throw new AppError('INSUFFICIENT_STOCK', `Only ${p.qtyOnHand} ${p.unit} of ${p.name} in stock (requested ${l.quantity}). Receive stock or correct the count first.`);
        }
        warnings.push(`${p.name}: selling more than recorded stock (${p.qtyOnHand}).`);
      }
      lines.push({
        productId,
        sku: p.sku,
        name: p.name,
        unit: p.unit,
        quantity: l.quantity,
        unitPricePaisa: p.pricePaisa,
        lineSubtotalPaisa: lineSubtotal,
        discountPaisa: l.discountPaisa,
        lineTotalPaisa: lineSubtotal - promoDiscount - l.discountPaisa,
        qtyAvailable: p.qtyOnHand,
        promoDiscountPaisa: promoDiscount,
        promotionId: promo?.id ?? null,
        promotionName: promo ? `${promo.name} ${promo.percentBp / 100}%` : null,
      });
    }
    const subtotal = lines.reduce((a, l) => a + l.lineSubtotalPaisa, 0);
    const lineDiscount = lines.reduce((a, l) => a + l.discountPaisa, 0);
    const promoDiscount = lines.reduce((a, l) => a + l.promoDiscountPaisa, 0);
    if (q.orderDiscountPaisa > subtotal - promoDiscount - lineDiscount) throw invalid('Order discount is larger than the amount due');
    const discount = promoDiscount + lineDiscount + q.orderDiscountPaisa;
    const manualDiscount = lineDiscount + q.orderDiscountPaisa;
    const taxable = subtotal - discount;

    // Tax only applies when explicitly configured AND marked verified by an administrator.
    const t = settings.tax;
    const taxOn = t.enabled && t.verified && t.rateBp > 0;
    let tax = 0;
    let total = taxable;
    if (taxOn) {
      if (t.inclusive) tax = Math.round((taxable * t.rateBp) / (10000 + t.rateBp));
      else {
        tax = Math.round((taxable * t.rateBp) / 10000);
        total = taxable + tax;
      }
    }
    const maxBp = settings.pos.cashierMaxDiscountBp;
    // Only manual discounts count toward the cashier limit; scheduled promotions were set by an admin.
    const discountRequiresApproval = user.role !== 'admin' && manualDiscount > 0 && manualDiscount * 10000 > subtotal * maxBp;
    const schemes = this.promos.evaluate(total);
    return {
      lines,
      subtotalPaisa: subtotal,
      lineDiscountPaisa: lineDiscount,
      orderDiscountPaisa: q.orderDiscountPaisa,
      discountPaisa: discount,
      taxablePaisa: taxable,
      taxPaisa: tax,
      totalPaisa: total,
      tax: { enabled: taxOn, label: t.label, rateBp: t.rateBp, inclusive: t.inclusive },
      discountRequiresApproval,
      warnings,
      promoDiscountPaisa: promoDiscount,
      qualifyingSchemes: schemes.qualifying,
      nearSchemes: schemes.near,
    };
  }

  /**
   * Completes a sale atomically: sale header, item price/cost snapshots, stock deductions with
   * ledger rows, payment, receipt number, audit and outbox event — all in ONE transaction.
   * Idempotent on clientTxnId: re-submitting the same checkout returns the original sale.
   */
  complete(user: SessionUser, input: unknown): SaleDetail {
    const c = completeSaleSchema.parse(input);
    const existingId = this.sales.idByClientTxn(c.clientTxnId);
    if (existingId) return this.sales.detail(existingId)!;

    const settings = this.settings.getSettings();
    const method = settings.paymentMethods.find((m) => m.code === c.payment.method && m.enabled);
    if (!method) throw invalid(`Payment method "${c.payment.method}" is not enabled`);

    const saleId = tx(this.ctx.db, () => {
      // Re-check inside the lock in case a duplicate submit raced us.
      const raced = this.sales.idByClientTxn(c.clientTxnId);
      if (raced) return raced;

      const q = this.quote(user, c);
      if (q.totalPaisa !== c.expectedTotalPaisa) {
        throw new AppError('PRICE_CHANGED', 'Prices changed since the cart was built. Review the updated total and confirm again.');
      }
      let approvedBy: number | null = null;
      if (q.discountRequiresApproval) {
        if (!c.override) throw new AppError('APPROVAL_REQUIRED', `Discount above ${settings.pos.cashierMaxDiscountBp / 100}% needs administrator approval`);
        approvedBy = this.auth.verifyOverride(c.override, 'discount').id;
      }
      let tendered = c.payment.tenderedPaisa;
      let change = 0;
      if (method.code === 'cash') {
        if (tendered < q.totalPaisa) throw invalid('Amount tendered is less than the total');
        change = tendered - q.totalPaisa;
      } else {
        if (method.requiresReference && !c.payment.reference) throw invalid(`${method.label} needs a reference / transaction ID`);
        tendered = q.totalPaisa;
      }

      const isDemo = this.settings.isDemo();
      const date = businessDate(this.ctx.clock);
      const fy = this.fiscal.forDate(date);
      const n = this.seq.next(`SALE:${fy.code}`);
      const receiptNo = `${settings.receipt.prefix}/${fiscalShort(fy.code)}/${String(n).padStart(6, '0')}`;

      const customerId = c.customer ? this.promos.repo.upsertCustomer(c.customer.name, c.customer.phone, isDemo) : null;
      const id = this.sales.insertSale({
        receiptNo,
        clientTxnId: c.clientTxnId,
        fiscalYear: fy.code,
        businessDate: date,
        cashierId: user.id,
        customerName: c.customerName ?? c.customer?.name ?? null,
        customerId,
        promoDiscountPaisa: q.promoDiscountPaisa,
        subtotalPaisa: q.subtotalPaisa,
        discountPaisa: q.discountPaisa,
        orderDiscountPaisa: q.orderDiscountPaisa,
        taxPaisa: q.taxPaisa,
        taxLabel: q.tax.enabled ? q.tax.label : null,
        taxRateBp: q.tax.enabled ? q.tax.rateBp : 0,
        taxInclusive: q.tax.inclusive,
        totalPaisa: q.totalPaisa,
        discountApprovedBy: approvedBy,
        isDemo,
      });

      const orderAlloc = allocate(q.orderDiscountPaisa, q.lines.map((l) => l.lineTotalPaisa));
      const nets = q.lines.map((l, i) => l.lineTotalPaisa - orderAlloc[i]!);
      const taxAlloc = allocate(q.taxPaisa, nets);
      const grossAlloc = q.tax.enabled && !q.tax.inclusive ? nets.map((n, i) => n + taxAlloc[i]!) : nets;
      const products = new Map(this.products.byIds(q.lines.map((l) => l.productId)).map((p) => [p.id, p]));

      q.lines.forEach((l, i) => {
        const p = products.get(l.productId)!;
        const lineNet = q.tax.enabled && q.tax.inclusive ? nets[i]! - taxAlloc[i]! : nets[i]!;
        const itemId = this.sales.insertItem({
          saleId: id,
          productId: l.productId,
          sku: l.sku,
          name: l.name,
          unit: l.unit,
          quantity: l.quantity,
          unitPricePaisa: l.unitPricePaisa,
          unitCostPaisa: p.costPaisa,
          discountPaisa: l.promoDiscountPaisa + l.discountPaisa + orderAlloc[i]!,
          promoDiscountPaisa: l.promoDiscountPaisa,
          promotionId: l.promotionId,
          promotionName: l.promotionName,
          lineTotalPaisa: lineNet,
          taxPaisa: taxAlloc[i]!,
          grossPaisa: grossAlloc[i]!,
        });
        this.stock.move({ productId: l.productId, type: 'sale', quantityDelta: -l.quantity, refType: 'sale_item', refId: itemId, refLabel: receiptNo, userId: user.id, isDemo });
        if (p.trackExpiry) this.stock.consumeBatches(l.productId, l.quantity);
      });

      this.sales.insertPayment({ saleId: id, returnId: null, kind: 'payment', method: method.code, amountPaisa: q.totalPaisa, tenderedPaisa: tendered, changePaisa: change, reference: c.payment.reference ?? null, userId: user.id, isDemo });
      if (q.discountPaisa > 0) {
        this.audit.log({ action: 'sale.discount', entityType: 'sale', entityId: id, userId: user.id, approvedBy, details: { receiptNo, discountPaisa: q.discountPaisa, subtotalPaisa: q.subtotalPaisa } });
      }
      let coupons: string[] = [];
      if (customerId) {
        coupons = this.promos.issueForSale(id, q.totalPaisa, customerId, isDemo);
        if (coupons.length) this.audit.log({ action: 'scheme.coupons_issued', entityType: 'sale', entityId: id, userId: user.id, details: { receiptNo, coupons } });
      }
      this.audit.log({ action: 'sale.completed', entityType: 'sale', entityId: id, userId: user.id, details: { receiptNo, totalPaisa: q.totalPaisa, lines: q.lines.length, promoDiscountPaisa: q.promoDiscountPaisa } });
      this.outbox.enqueue('sale.completed', 'sale', id, { receiptNo, totalPaisa: q.totalPaisa, fiscalYear: fy.code });
      return id;
    });
    return this.sales.detail(saleId)!;
  }

  list(input: unknown) {
    return this.sales.list(salesQuerySchema.parse(input ?? {}));
  }

  get(id: number): SaleDetail {
    const s = this.sales.detail(id);
    if (!s) throw notFound('Sale');
    return s;
  }

  private approver(user: SessionUser, override: unknown, purpose: string): number | null {
    if (user.role === 'admin') return null;
    if (!override) throw new AppError('APPROVAL_REQUIRED', `A ${purpose} needs administrator approval`);
    return this.auth.verifyOverride(override, purpose).id;
  }

  /** Voids a whole sale: reverses stock with ledger rows, records a refund payment. Never deletes. */
  void(user: SessionUser, input: unknown): SaleDetail {
    const v = voidSaleSchema.parse(input);
    tx(this.ctx.db, () => {
      const sale = this.sales.detail(v.saleId);
      if (!sale) throw notFound('Sale');
      if (sale.status !== 'completed') throw invalid(sale.status === 'voided' ? 'This sale is already voided' : 'A sale with returns cannot be voided; use a return instead');
      const approvedBy = this.approver(user, v.override, 'void');
      const isDemo = sale.isDemo ? 1 : 0;
      for (const item of this.sales.items(sale.id)) {
        this.stock.move({ productId: item.productId, type: 'void', quantityDelta: item.quantity, reason: v.reason, refType: 'sale_item', refId: item.id, refLabel: sale.receiptNo, userId: user.id, isDemo });
      }
      const method = sale.payments.find((p) => p.kind === 'payment')?.method ?? 'cash';
      this.sales.insertPayment({ saleId: sale.id, returnId: null, kind: 'refund', method, amountPaisa: sale.totalPaisa, tenderedPaisa: null, changePaisa: null, reference: 'VOID', userId: user.id, isDemo });
      this.sales.markVoided(sale.id, user.id, v.reason);
      this.audit.log({ action: 'sale.voided', entityType: 'sale', entityId: sale.id, userId: user.id, approvedBy, details: { receiptNo: sale.receiptNo, totalPaisa: sale.totalPaisa, reason: v.reason } });
      this.outbox.enqueue('sale.voided', 'sale', sale.id, { receiptNo: sale.receiptNo, reason: v.reason });
    });
    return this.sales.detail(v.saleId)!;
  }

  /** Partial or full return. Quantity can never exceed what was sold minus what was already returned. */
  createReturn(user: SessionUser, input: unknown): SaleDetail {
    const r = returnSchema.parse(input);
    tx(this.ctx.db, () => {
      const sale = this.sales.detail(r.saleId);
      if (!sale) throw notFound('Sale');
      if (sale.status === 'voided') throw invalid('This sale was voided; nothing can be returned');
      if (sale.status === 'returned') throw invalid('All items on this sale were already returned');
      const approvedBy = this.approver(user, r.override, 'return / refund');
      const items = new Map(this.sales.items(sale.id).map((i) => [i.id, i]));
      const requested = new Map<number, number>();
      for (const it of r.items) requested.set(it.saleItemId, (requested.get(it.saleItemId) ?? 0) + it.quantity);

      const lines: { itemId: number; qty: number; refund: number; productId: number }[] = [];
      for (const [itemId, qty] of requested) {
        const item = items.get(itemId);
        if (!item) throw invalid('An item does not belong to this sale');
        const left = item.quantity - item.returnedQuantity;
        if (qty > left) throw invalid(`Cannot return ${qty} × ${item.name}: only ${left} left to return`);
        const refund = cumulativeShare(item.grossPaisa, item.returnedQuantity + qty, item.quantity) - cumulativeShare(item.grossPaisa, item.returnedQuantity, item.quantity);
        lines.push({ itemId, qty, refund, productId: item.productId });
      }
      const refundTotal = lines.reduce((a, l) => a + l.refund, 0);
      const isDemo = sale.isDemo ? 1 : 0;
      const date = businessDate(this.ctx.clock);
      const fy = this.fiscal.forDate(date);
      const prefix = this.settings.getSettings().receipt.prefix;
      const returnNo = `${prefix}-R/${fiscalShort(fy.code)}/${String(this.seq.next(`RETURN:${fy.code}`)).padStart(6, '0')}`;
      const returnId = this.sales.insertReturn({ returnNo, saleId: sale.id, fiscalYear: fy.code, businessDate: date, reason: r.reason, restock: r.restock, refundPaisa: refundTotal, createdBy: user.id, approvedBy, isDemo });
      for (const l of lines) {
        const riId = this.sales.insertReturnItem(returnId, l.itemId, l.qty, l.refund);
        this.sales.addReturnedQty(l.itemId, l.qty);
        if (r.restock) {
          this.stock.move({ productId: l.productId, type: 'return', quantityDelta: l.qty, reason: r.reason, refType: 'return_item', refId: riId, refLabel: returnNo, userId: user.id, isDemo });
        }
      }
      const method = sale.payments.find((p) => p.kind === 'payment')?.method ?? 'cash';
      this.sales.insertPayment({ saleId: sale.id, returnId, kind: 'refund', method, amountPaisa: refundTotal, tenderedPaisa: null, changePaisa: null, reference: returnNo, userId: user.id, isDemo });
      const after = this.sales.items(sale.id);
      const fully = after.every((i) => i.returnedQuantity === i.quantity);
      this.sales.setStatus(sale.id, fully ? 'returned' : 'partially_returned');
      this.audit.log({ action: 'sale.returned', entityType: 'sale', entityId: sale.id, userId: user.id, approvedBy, details: { receiptNo: sale.receiptNo, returnNo, refundPaisa: refundTotal, restock: r.restock, reason: r.reason } });
      this.outbox.enqueue('sale.returned', 'sale', sale.id, { returnNo, refundPaisa: refundTotal });
    });
    return this.sales.detail(r.saleId)!;
  }

  ensureCanView(user: SessionUser | null) {
    if (!user) throw forbidden();
  }
}
