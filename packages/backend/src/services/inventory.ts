import type { SessionUser, StockMovement } from '@srmart/shared';
import { adjustmentSchema } from '@srmart/shared';
import type { Ctx } from '../context';
import { businessDate } from '../clock';
import { tx } from '../db/database';
import { invalid, notFound } from '../errors';
import { AuditRepo } from '../repositories/auditRepo';
import { ProductRepo } from '../repositories/productRepo';
import { SettingsRepo } from '../repositories/settingsRepo';
import { StockRepo } from '../repositories/stockRepo';
import { requireRole } from './auth';

const REASON_LABEL: Record<string, string> = {
  count_correction: 'Stock count correction',
  damaged: 'Damaged',
  expired: 'Expired',
  lost_or_stolen: 'Lost or stolen',
  internal_use: 'Internal use',
  other: 'Other',
};

export class InventoryService {
  readonly stock: StockRepo;
  private products: ProductRepo;
  private audit: AuditRepo;
  private settings: SettingsRepo;

  constructor(private ctx: Ctx) {
    this.stock = new StockRepo(ctx);
    this.products = new ProductRepo(ctx);
    this.audit = new AuditRepo(ctx);
    this.settings = new SettingsRepo(ctx);
  }

  adjust(user: SessionUser, input: unknown): StockMovement {
    requireRole(user, 'admin');
    const a = adjustmentSchema.parse(input);
    return tx(this.ctx.db, () => {
      const p = this.products.byId(a.productId);
      if (!p) throw notFound('Product');
      if (p.qtyOnHand + a.quantityDelta < 0 && !this.settings.getSettings().pos.allowNegativeStock) {
        throw invalid(`Adjustment would make stock negative (on hand: ${p.qtyOnHand})`);
      }
      const reason = `${REASON_LABEL[a.reason]}: ${a.note}`;
      const m = this.stock.move({ productId: p.id, type: 'adjustment', quantityDelta: a.quantityDelta, reason, userId: user.id, isDemo: p.isDemo ? 1 : 0, refLabel: 'ADJ' });
      if (a.quantityDelta < 0) this.stock.consumeBatches(p.id, -a.quantityDelta);
      this.audit.log({ action: 'stock.adjusted', entityType: 'product', entityId: p.id, userId: user.id, details: { sku: p.sku, delta: a.quantityDelta, before: p.qtyOnHand, after: m.balanceAfter, reason: a.reason, note: a.note } });
      return m;
    });
  }

  movements(input: { productId?: number; type?: StockMovement['type']; page?: number; pageSize?: number } = {}) {
    return this.stock.list({ productId: input.productId, type: input.type, page: Math.max(1, input.page ?? 1), pageSize: Math.min(200, Math.max(5, input.pageSize ?? 50)) });
  }

  lowStock() {
    return this.products.lowStock();
  }

  expiring(days: number) {
    const d = Number.isFinite(days) ? Math.min(Math.max(Math.trunc(days), 0), 365) : 30;
    return this.stock.expiring(d, businessDate(this.ctx.clock));
  }
}
