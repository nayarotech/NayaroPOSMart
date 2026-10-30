import { afterEach, describe, expect, it } from 'vitest';
import { tx } from '../src/db/database';
import { checkout, harness, makeProduct, type Harness } from './helpers';

let h: Harness;
afterEach(() => h?.close());
const day1 = '2026-10-28';
const day2 = '2026-10-29';
const nextDay = () => h.clock.advance(86_400_000);

function refund(saleId: number, itemId: number, quantity: number, restock = true) {
  return h.svc.sales.createReturn(h.admin, { saleId, reason: 'Customer return', restock, items: [{ saleItemId: itemId, quantity }] });
}
function batchProduct() {
  const p = makeProduct(h, { openingQty: 0 });
  tx(h.db, () => {
    h.svc.inventory.stock.move({ productId: p.id, type: 'purchase', quantityDelta: 5, userId: h.admin.id, isDemo: 0 });
    h.svc.inventory.stock.insertBatch({ productId: p.id, purchaseItemId: null, batchNo: 'early', expiryDate: '2026-11-01', qty: 2 });
    h.svc.inventory.stock.insertBatch({ productId: p.id, purchaseItemId: null, batchNo: 'late', expiryDate: '2026-12-01', qty: 3 });
  });
  return p;
}
function remaining() {
  return (h.db.prepare('SELECT qty_remaining n FROM product_batches ORDER BY expiry_date').all() as { n: number }[]).map((r) => r.n);
}

describe('dated reporting', () => {
  it('keeps original sales stable and includes a refund-only day in totals, products and payments', () => {
    h = harness();
    const p = makeProduct(h);
    const sale = checkout(h, h.admin, [{ productId: p.id, quantity: 3 }]);
    const original = h.svc.reports.totals(day1, day1);
    nextDay();
    refund(sale.id, sale.items[0]!.id, 1);
    expect(h.svc.reports.totals(day1, day1)).toEqual(original);
    const report = h.svc.reports.salesReport({ from: day2, to: day2, groupBy: 'day' });
    expect(report.totals).toMatchObject({ salesCount: 0, netSalesPaisa: -10000, refundsPaisa: 10000, costOfGoodsPaisa: -8000, estimatedMarginPaisa: -2000 });
    expect(report.buckets).toHaveLength(1);
    expect(report.payments).toEqual([{ method: 'cash', kind: 'refund', count: 1, amountPaisa: 10000 }]);
    expect(report.topProducts[0]).toMatchObject({ productId: p.id, quantity: -1, netPaisa: -10000 });
    expect(report.byCategory[0]?.netPaisa).toBe(-10000);
    expect(h.svc.reports.dashboard().today.netSalesPaisa).toBe(-10000);
  });

  it('dates void reversals on the void day without rewriting the original day', () => {
    h = harness();
    const p = makeProduct(h);
    const sale = checkout(h, h.admin, [{ productId: p.id, quantity: 2 }]);
    const before = h.svc.reports.totals(day1, day1);
    nextDay();
    h.svc.sales.void(h.admin, { saleId: sale.id, reason: 'Incorrect sale' });
    expect(h.svc.reports.totals(day1, day1)).toEqual(before);
    expect(h.svc.reports.totals(day2, day2)).toMatchObject({ netSalesPaisa: -20000, refundsPaisa: 20000, costOfGoodsPaisa: -16000 });
    expect(h.svc.reports.totals(day1, day2)).toMatchObject({ netSalesPaisa: 0, costOfGoodsPaisa: 0, estimatedMarginPaisa: 0 });
  });

  it('allocates tax and net refund rounding across repeated returns and retains cost for discarded goods', () => {
    h = harness();
    const settings = h.svc.settings.get();
    h.svc.settings.update(h.admin, { ...settings, tax: { ...settings.tax, enabled: true, verified: true, label: 'Test tax', verificationNote: 'Test-only configuration', rateBp: 1300, inclusive: true } });
    const p = makeProduct(h, { pricePaisa: 101, costPaisa: 50 });
    const sale = checkout(h, h.admin, [{ productId: p.id, quantity: 3 }], { orderDiscountPaisa: 1 });
    nextDay();
    refund(sale.id, sale.items[0]!.id, 1, false);
    refund(sale.id, sale.items[0]!.id, 1);
    refund(sale.id, sale.items[0]!.id, 1);
    const all = h.svc.reports.totals(day1, day2);
    expect(all).toMatchObject({ netSalesPaisa: 0, taxPaisa: 0, refundsPaisa: sale.totalPaisa, costOfGoodsPaisa: 50, estimatedMarginPaisa: -50 });
  });
});

describe('batch reversals', () => {
  it('restores exact FEFO batches on void even for a product without expiry tracking enabled', () => {
    h = harness();
    const p = batchProduct();
    const sale = checkout(h, h.admin, [{ productId: p.id, quantity: 4 }]);
    expect(remaining()).toEqual([0, 1]);
    h.svc.sales.void(h.admin, { saleId: sale.id, reason: 'Incorrect sale' });
    expect(remaining()).toEqual([2, 3]);
  });

  it('skips discarded returns and restores later allocations only once', () => {
    h = harness();
    const p = batchProduct();
    const sale = checkout(h, h.admin, [{ productId: p.id, quantity: 4 }]);
    const itemId = sale.items[0]!.id;
    refund(sale.id, itemId, 2, false);
    expect(remaining()).toEqual([0, 1]);
    refund(sale.id, itemId, 2);
    expect(remaining()).toEqual([0, 3]);
    expect(() => refund(sale.id, itemId, 1)).toThrow();
    expect(remaining()).toEqual([0, 3]);
  });

  it('does not invent a batch source for legacy sales', () => {
    h = harness();
    const p = batchProduct();
    const sale = checkout(h, h.admin, [{ productId: p.id, quantity: 2 }]);
    h.db.prepare('DELETE FROM sale_batch_allocations').run();
    refund(sale.id, sale.items[0]!.id, 2);
    expect(remaining()).toEqual([0, 3]);
    expect(h.svc.products.get(p.id).qtyOnHand).toBe(5);
  });
});
