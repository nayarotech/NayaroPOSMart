import type { PurchaseDetail, SessionUser } from '@srmart/shared';
import { purchaseInputSchema, supplierInputSchema } from '@srmart/shared';
import type { Ctx } from '../context';
import { tx } from '../db/database';
import { conflict, invalid, notFound } from '../errors';
import { AuditRepo } from '../repositories/auditRepo';
import { ProductRepo } from '../repositories/productRepo';
import { PurchaseRepo } from '../repositories/purchaseRepo';
import { SequenceRepo } from '../repositories/sequenceRepo';
import { SettingsRepo } from '../repositories/settingsRepo';
import { StockRepo } from '../repositories/stockRepo';
import { requireRole } from './auth';
import { FiscalService } from './fiscal';
import { Outbox } from './outbox';
import { fiscalShort } from './sales';

export class PurchaseService {
  readonly repo: PurchaseRepo;
  private products: ProductRepo;
  private stock: StockRepo;
  private audit: AuditRepo;
  private seq: SequenceRepo;
  private settings: SettingsRepo;
  private fiscal: FiscalService;
  private outbox: Outbox;

  constructor(private ctx: Ctx) {
    this.repo = new PurchaseRepo(ctx);
    this.products = new ProductRepo(ctx);
    this.stock = new StockRepo(ctx);
    this.audit = new AuditRepo(ctx);
    this.seq = new SequenceRepo(ctx);
    this.settings = new SettingsRepo(ctx);
    this.fiscal = new FiscalService(ctx);
    this.outbox = new Outbox(ctx);
  }

  createSupplier(user: SessionUser, input: unknown) {
    requireRole(user, 'admin');
    const s = supplierInputSchema.parse(input);
    if (this.repo.suppliers().some((x) => x.name.toLowerCase() === s.name.toLowerCase())) throw conflict(`Supplier "${s.name}" already exists`);
    const id = this.repo.insertSupplier(s, this.settings.isDemo());
    this.audit.log({ action: 'supplier.created', entityType: 'supplier', entityId: id, userId: user.id, details: { name: s.name } });
    return this.repo.supplier(id)!;
  }

  updateSupplier(user: SessionUser, input: unknown) {
    requireRole(user, 'admin');
    const id = Number((input as { id?: unknown })?.id);
    if (!Number.isInteger(id) || id <= 0) throw invalid('Supplier id is required');
    const s = supplierInputSchema.parse(input);
    if (!this.repo.supplier(id)) throw notFound('Supplier');
    this.repo.updateSupplier(id, s);
    this.audit.log({ action: 'supplier.updated', entityType: 'supplier', entityId: id, userId: user.id, details: { name: s.name } });
    return this.repo.supplier(id)!;
  }

  /** Records a supplier invoice and receives every line into stock in one transaction. */
  receive(user: SessionUser, input: unknown): PurchaseDetail {
    requireRole(user, 'admin');
    const p = purchaseInputSchema.parse(input);
    const id = tx(this.ctx.db, () => {
      if (!this.repo.supplier(p.supplierId)) throw notFound('Supplier');
      if (this.repo.findByInvoice(p.supplierId, p.invoiceNo)) {
        throw conflict(`Invoice ${p.invoiceNo} from this supplier was already received — receiving it again would double the stock`);
      }
      const products = new Map(this.products.byIds(p.items.map((i) => i.productId)).map((x) => [x.id, x]));
      for (const i of p.items) if (!products.has(i.productId)) throw notFound(`Product #${i.productId}`);
      const isDemo = this.settings.isDemo();
      const fy = this.fiscal.forDate(p.invoiceDate);
      const purchaseNo = `PUR/${fiscalShort(fy.code)}/${String(this.seq.next(`PURCHASE:${fy.code}`)).padStart(5, '0')}`;
      const total = p.items.reduce((a, i) => a + i.quantity * i.unitCostPaisa, 0);
      const purchaseId = this.repo.insertPurchase({ purchaseNo, supplierId: p.supplierId, invoiceNo: p.invoiceNo, invoiceDate: p.invoiceDate, fiscalYear: fy.code, totalPaisa: total, notes: p.notes, userId: user.id, isDemo });
      for (const i of p.items) {
        const product = products.get(i.productId)!;
        const itemId = this.repo.insertItem({ purchaseId, ...i, batchNo: i.batchNo ?? null, expiryDate: i.expiryDate ?? null });
        this.stock.move({ productId: i.productId, type: 'purchase', quantityDelta: i.quantity, refType: 'purchase_item', refId: itemId, refLabel: purchaseNo, userId: user.id, isDemo });
        if (product.trackExpiry || i.expiryDate || i.batchNo) {
          this.stock.insertBatch({ productId: i.productId, purchaseItemId: itemId, batchNo: i.batchNo ?? null, expiryDate: i.expiryDate ?? null, qty: i.quantity });
        }
        if (p.updateCostPrice && i.unitCostPaisa !== product.costPaisa) {
          this.products.setCost(i.productId, i.unitCostPaisa);
          this.products.insertPrice(i.productId, product.pricePaisa, i.unitCostPaisa, user.id, `Cost from ${purchaseNo}`);
          this.audit.log({ action: 'product.cost_changed', entityType: 'product', entityId: i.productId, userId: user.id, details: { oldCostPaisa: product.costPaisa, newCostPaisa: i.unitCostPaisa, source: purchaseNo } });
        }
      }
      this.audit.log({ action: 'purchase.received', entityType: 'purchase', entityId: purchaseId, userId: user.id, details: { purchaseNo, invoiceNo: p.invoiceNo, totalPaisa: total, lines: p.items.length } });
      this.outbox.enqueue('purchase.received', 'purchase', purchaseId, { purchaseNo, totalPaisa: total });
      return purchaseId;
    });
    return this.repo.detail(id)!;
  }

  get(id: number) {
    const d = this.repo.detail(id);
    if (!d) throw notFound('Purchase');
    return d;
  }
}
