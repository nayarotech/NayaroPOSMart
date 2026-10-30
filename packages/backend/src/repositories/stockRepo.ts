import type { Batch, MovementType, Page, StockMovement } from '@srmart/shared';
import type { Ctx } from '../context';

export interface MoveInput {
  productId: number;
  type: MovementType;
  quantityDelta: number;
  reason?: string | null;
  refType?: string | null;
  refId?: number | null;
  refLabel?: string | null;
  userId: number | null;
  isDemo: number;
}

function mapMovement(r: Record<string, unknown>): StockMovement {
  return {
    id: r.id as number,
    productId: r.product_id as number,
    sku: r.sku as string,
    productName: r.product_name as string,
    type: r.type as MovementType,
    quantityDelta: r.quantity_delta as number,
    balanceAfter: r.balance_after as number,
    reason: (r.reason as string) ?? null,
    refType: (r.ref_type as string) ?? null,
    refId: (r.ref_id as number) ?? null,
    refLabel: (r.ref_label as string) ?? null,
    userName: (r.user_name as string) ?? null,
    createdAt: r.created_at as string,
  };
}

const SELECT = `SELECT m.*, p.sku, p.name AS product_name, u.full_name AS user_name
  FROM stock_movements m JOIN products p ON p.id = m.product_id LEFT JOIN users u ON u.id = m.user_id`;

export class StockRepo {
  constructor(private ctx: Ctx) {}

  /**
   * The ONLY way stock changes: updates the cached quantity and writes a ledger row.
   * Callers must already be inside a transaction.
   */
  move(m: MoveInput): StockMovement {
    if (!this.ctx.db.inTransaction) throw new Error('Stock movements must run inside a transaction');
    const row = this.ctx.db
      .prepare('UPDATE products SET qty_on_hand = qty_on_hand + ?, updated_at = ? WHERE id = ? RETURNING qty_on_hand')
      .get(m.quantityDelta, this.ctx.clock.now().toISOString(), m.productId) as { qty_on_hand: number } | undefined;
    if (!row) throw new Error(`Product ${m.productId} not found for stock movement`);
    const res = this.ctx.db
      .prepare(
        `INSERT INTO stock_movements (product_id, type, quantity_delta, balance_after, reason, ref_type, ref_id, ref_label, user_id, is_demo, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(m.productId, m.type, m.quantityDelta, row.qty_on_hand, m.reason ?? null, m.refType ?? null, m.refId ?? null, m.refLabel ?? null, m.userId, m.isDemo, this.ctx.clock.now().toISOString());
    return this.byId(Number(res.lastInsertRowid))!;
  }

  byId(id: number): StockMovement | null {
    const r = this.ctx.db.prepare(`${SELECT} WHERE m.id = ?`).get(id) as Record<string, unknown> | undefined;
    return r ? mapMovement(r) : null;
  }

  list(f: { productId?: number; type?: MovementType; page: number; pageSize: number }): Page<StockMovement> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (f.productId) {
      where.push('m.product_id = ?');
      params.push(f.productId);
    }
    if (f.type) {
      where.push('m.type = ?');
      params.push(f.type);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (this.ctx.db.prepare(`SELECT COUNT(*) n FROM stock_movements m ${w}`).get(...params) as { n: number }).n;
    const rows = this.ctx.db.prepare(`${SELECT} ${w} ORDER BY m.id DESC LIMIT ? OFFSET ?`).all(...params, f.pageSize, (f.page - 1) * f.pageSize) as Record<string, unknown>[];
    return { rows: rows.map(mapMovement), total, page: f.page, pageSize: f.pageSize };
  }

  /** Sum of the ledger — used by tests and integrity checks to prove qty_on_hand matches movements. */
  ledgerBalance(productId: number): number {
    return (this.ctx.db.prepare('SELECT COALESCE(SUM(quantity_delta), 0) n FROM stock_movements WHERE product_id = ?').get(productId) as { n: number }).n;
  }

  // --- batches (optional expiry tracking) ---
  insertBatch(b: { productId: number; purchaseItemId: number | null; batchNo: string | null; expiryDate: string | null; qty: number }) {
    this.ctx.db
      .prepare('INSERT INTO product_batches (product_id, purchase_item_id, batch_no, expiry_date, qty_received, qty_remaining, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(b.productId, b.purchaseItemId, b.batchNo, b.expiryDate, b.qty, b.qty, this.ctx.clock.now().toISOString());
  }

  /** First-expiry-first-out consumption of batch quantities (informational; product qty is authoritative). */
  consumeBatches(productId: number, qty: number, saleItemId?: number) {
    if (!this.ctx.db.inTransaction) throw new Error('Batch consumption requires a transaction');
    let left = qty;
    const batches = this.ctx.db
      .prepare(`SELECT id, qty_remaining FROM product_batches WHERE product_id = ? AND qty_remaining > 0 ORDER BY expiry_date IS NULL, expiry_date, id`)
      .all(productId) as { id: number; qty_remaining: number }[];
    const upd = this.ctx.db.prepare('UPDATE product_batches SET qty_remaining = ? WHERE id = ?');
    for (const b of batches) {
      if (left <= 0) break;
      const take = Math.min(left, b.qty_remaining);
      upd.run(b.qty_remaining - take, b.id);
      if (saleItemId) this.ctx.db.prepare('INSERT INTO sale_batch_allocations (sale_item_id, batch_id, quantity) VALUES (?, ?, ?)').run(saleItemId, b.id, take);
      left -= take;
    }
    if (saleItemId && left > 0) this.ctx.db.prepare('INSERT INTO sale_batch_allocations (sale_item_id, batch_id, quantity) VALUES (?, NULL, ?)').run(saleItemId, left);
  }

  /** Restore only the units being restocked. Returned-but-discarded units still advance the offset. */
  restoreSaleBatches(saleItemId: number, previouslyReturned: number, qty: number) {
    if (!this.ctx.db.inTransaction) throw new Error('Batch restoration requires a transaction');
    const allocations = this.ctx.db.prepare('SELECT batch_id, quantity FROM sale_batch_allocations WHERE sale_item_id = ? ORDER BY id').all(saleItemId) as { batch_id: number | null; quantity: number }[];
    let offset = 0;
    for (const a of allocations) {
      const overlap = Math.max(0, Math.min(offset + a.quantity, previouslyReturned + qty) - Math.max(offset, previouslyReturned));
      if (overlap && a.batch_id !== null) this.ctx.db.prepare('UPDATE product_batches SET qty_remaining = qty_remaining + ? WHERE id = ?').run(overlap, a.batch_id);
      offset += a.quantity;
    }
    // Legacy sales have no allocations: leave batch quantities unchanged rather than guess their source.
  }

  expiring(withinDays: number, today: string): Batch[] {
    return (
      this.ctx.db
        .prepare(
          `SELECT b.*, p.name AS product_name, p.sku, CAST(julianday(b.expiry_date) - julianday(?) AS INTEGER) AS days
           FROM product_batches b JOIN products p ON p.id = b.product_id
           WHERE b.qty_remaining > 0 AND b.expiry_date IS NOT NULL AND julianday(b.expiry_date) - julianday(?) <= ?
           ORDER BY b.expiry_date`,
        )
        .all(today, today, withinDays) as Record<string, unknown>[]
    ).map((r) => ({
      id: r.id as number,
      productId: r.product_id as number,
      productName: r.product_name as string,
      sku: r.sku as string,
      batchNo: (r.batch_no as string) ?? null,
      expiryDate: (r.expiry_date as string) ?? null,
      qtyReceived: r.qty_received as number,
      qtyRemaining: r.qty_remaining as number,
      daysToExpiry: (r.days as number) ?? null,
    }));
  }
}
