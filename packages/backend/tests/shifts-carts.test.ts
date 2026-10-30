import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { checkout, harness, makeProduct, type Harness } from './helpers';
import { renderShiftHtml } from '../src/render/shift';

let h: Harness;
afterEach(() => h?.close());
const uuid = () => crypto.randomUUID();
function saveCart(productId: number, quantity = 1) {
  return h.svc.carts.save(h.cashier, { id: uuid(), revision: 0, lines: [{ productId, quantity, discountPaisa: 0 }], orderDiscountPaisa: 0 });
}
function payCart(cart: ReturnType<typeof saveCart>) {
  const lines = cart.lines.map(({ productId, quantity, discountPaisa }) => ({ productId, quantity, discountPaisa }));
  const quote = h.svc.sales.quote(h.cashier, { lines, orderDiscountPaisa: cart.orderDiscountPaisa });
  return h.svc.sales.complete(h.cashier, { clientTxnId: cart.id, lines, orderDiscountPaisa: cart.orderDiscountPaisa,
    expectedTotalPaisa: quote.totalPaisa, payment: { method: 'cash', tenderedPaisa: quote.totalPaisa } });
}

describe('cash shifts', () => {
  it('reconciles net cash after change, manual movements, refunds and noncash payments', () => {
    h = harness();
    const shift = h.svc.shifts.open(h.cashier, { openingPaisa: 50000 });
    const p = makeProduct(h);
    const sale = checkout(h, h.cashier, [{ productId: p.id, quantity: 2 }], { tenderedPaisa: 50000 });
    h.svc.sales.createReturn(h.admin, { saleId: sale.id, reason: 'Customer return', restock: true, items: [{ saleItemId: sale.items[0]!.id, quantity: 1 }] });
    const settings = h.svc.settings.get();
    h.svc.settings.update(h.admin, { ...settings, paymentMethods: [...settings.paymentMethods.filter((m) => m.code !== 'test_wallet'), { code: 'test_wallet', label: 'Test wallet', enabled: true, requiresReference: true }] });
    const lines = [{ productId: p.id, quantity: 1 }];
    const q = h.svc.sales.quote(h.admin, { lines });
    h.svc.sales.complete(h.admin, { clientTxnId: uuid(), lines, expectedTotalPaisa: q.totalPaisa, payment: { method: 'test_wallet', reference: 'WALLET-1', tenderedPaisa: 0 } });
    h.svc.shifts.move(h.cashier, { shiftId: shift.id, clientTxnId: uuid(), kind: 'in', amountPaisa: 5000, reason: 'Extra change' });
    const movement = { shiftId: shift.id, clientTxnId: uuid(), kind: 'out' as const, amountPaisa: 2000, reason: 'Bank deposit' };
    h.svc.shifts.move(h.cashier, movement);
    h.svc.shifts.move(h.cashier, movement); // response retry cannot duplicate cash out
    const current = h.svc.shifts.current()!;
    expect(current).toMatchObject({ openingPaisa: 50000, expectedPaisa: 63000, cashInPaisa: 5000, cashOutPaisa: 2000 });
    expect(current.payments).toEqual([{ method: 'cash', receivedPaisa: 20000, refundedPaisa: 10000 }, { method: 'test_wallet', receivedPaisa: 10000, refundedPaisa: 0 }]);
    expect(current.movements).toHaveLength(2);
    const closed = h.svc.shifts.close(h.cashier, { shiftId: shift.id, countedPaisa: 62500, expectedPaisa: 63000, note: 'Cash shortage counted' });
    expect(closed.variancePaisa).toBe(-500);
    expect(h.svc.shifts.current()).toBeNull();
    expect(h.svc.shifts.close(h.cashier, { shiftId: shift.id, countedPaisa: 62500, expectedPaisa: 63000, note: 'Cash shortage counted' })).toEqual(closed);
    expect(h.svc.audit.list({ page: 1, pageSize: 100 }).rows.some((r) => r.action === 'shift.closed')).toBe(true);
  });

  it('preserves a closed shift when an old sale is refunded in a new shift', () => {
    h = harness();
    const p = makeProduct(h);
    const first = h.svc.shifts.open(h.cashier, { openingPaisa: 0 });
    const sale = checkout(h, h.cashier, [{ productId: p.id, quantity: 1 }]);
    const closed = h.svc.shifts.close(h.cashier, { shiftId: first.id, countedPaisa: 10000, expectedPaisa: 10000 });
    h.clock.advance(86_400_000);
    h = h.reopen();
    const second = h.svc.shifts.open(h.cashier, { openingPaisa: 20000 });
    h.svc.sales.void(h.admin, { saleId: sale.id, reason: 'Incorrect sale' });
    expect(h.svc.shifts.get(h.cashier, first.id)).toEqual(closed);
    expect(h.svc.shifts.get(h.cashier, second.id).expectedPaisa).toBe(10000);
    expect(h.svc.shifts.get(h.cashier, second.id).payments).toEqual([{ method: 'cash', receivedPaisa: 0, refundedPaisa: 10000 }]);
  });

  it('blocks concurrent shifts, unauthorized management, stale closing totals and unexplained variance', () => {
    h = harness();
    const shift = h.svc.shifts.open(h.admin, { openingPaisa: 10000 });
    expect(() => h.svc.shifts.open(h.cashier, { openingPaisa: 0 })).toThrow(/already open/);
    expect(() => h.svc.shifts.move(h.cashier, { shiftId: shift.id, clientTxnId: uuid(), kind: 'in', amountPaisa: 1, reason: 'Cash added' })).toThrow(/permission/);
    expect(() => h.svc.shifts.close(h.cashier, { shiftId: shift.id, countedPaisa: 10000, expectedPaisa: 10000 })).toThrow(/permission/);
    expect(h.svc.shifts.list(h.cashier)).toEqual([]);
    expect(() => h.svc.shifts.get(h.cashier, shift.id)).toThrow(/own shift/);
    h.svc.shifts.move(h.admin, { shiftId: shift.id, clientTxnId: uuid(), kind: 'in', amountPaisa: 100, reason: 'Cash added' });
    expect(() => h.svc.shifts.close(h.admin, { shiftId: shift.id, countedPaisa: 10000, expectedPaisa: 10000 })).toThrow(/changed/);
    expect(() => h.svc.shifts.close(h.admin, { shiftId: shift.id, countedPaisa: 10000, expectedPaisa: 10100 })).toThrow(/Explain/);
    expect(() => h.svc.shifts.move(h.admin, { shiftId: shift.id, clientTxnId: uuid(), kind: 'out', amountPaisa: 20000, reason: 'Too much' })).toThrow(/exceeds/);
  });

  it('makes closed shifts immutable, excludes unassigned sales and escapes printed notes', () => {
    h = harness();
    const p = makeProduct(h);
    checkout(h, h.cashier, [{ productId: p.id, quantity: 1 }]);
    const shift = h.svc.shifts.open(h.cashier, { openingPaisa: 0 });
    expect(shift.expectedPaisa).toBe(0);
    const closed = h.svc.shifts.close(h.cashier, { shiftId: shift.id, countedPaisa: 0, expectedPaisa: 0, note: '<script>bad</script>' });
    expect(renderShiftHtml(closed, h.svc.settings.get())).toContain('&lt;script&gt;bad&lt;/script&gt;');
    expect(() => h.db.prepare('UPDATE cash_shifts SET counted_paisa = 1 WHERE id = ?').run(shift.id)).toThrow(/immutable/);
    expect(() => h.db.prepare('DELETE FROM cash_shifts WHERE id = ?').run(shift.id)).toThrow(/deleted/);
    expect(() => h.svc.shifts.move(h.cashier, { shiftId: shift.id, clientTxnId: uuid(), kind: 'in', amountPaisa: 1, reason: 'Too late' })).toThrow(/closed/);
  });
});

describe('persistent checkout carts', () => {
  it('recovers active and named parked carts across restart without changing stock', () => {
    h = harness();
    const p = makeProduct(h);
    const first = saveCart(p.id, 2);
    h.svc.carts.park(h.cashier, { id: first.id, revision: first.revision, name: 'Collect later' });
    const second = saveCart(p.id, 3);
    h = h.reopen();
    expect(h.svc.carts.current(h.cashier)?.id).toBe(second.id);
    expect(h.svc.carts.list(h.cashier)[0]).toMatchObject({ id: first.id, name: 'Collect later' });
    expect(h.svc.products.get(p.id).qtyOnHand).toBe(p.qtyOnHand);
    expect(() => h.svc.carts.resume(h.cashier, { id: first.id, revision: first.revision + 1 })).toThrow(/Park or clear/);
    h.svc.carts.discard(h.cashier, { id: second.id, revision: second.revision });
    const parked = h.svc.carts.list(h.cashier)[0]!;
    const resumed = h.svc.carts.resume(h.cashier, { id: parked.id, revision: parked.revision });
    expect(resumed.id).toBe(first.id);
    expect(resumed.lines[0]?.quantity).toBe(2);
  });

  it('refreshes product prices and checks current stock on resumed checkout', () => {
    h = harness();
    const p = makeProduct(h);
    const cart = saveCart(p.id, 2);
    const parked = h.svc.carts.park(h.cashier, { id: cart.id, revision: cart.revision, name: 'Waiting' });
    h.svc.products.update(h.admin, { id: p.id, name: p.name, categoryId: p.categoryId, brand: p.brand, unit: p.unit, costPaisa: p.costPaisa, pricePaisa: 15000, minStock: p.minStock, trackExpiry: p.trackExpiry, priceChangeReason: 'New price' });
    const resumed = h.svc.carts.resume(h.cashier, { id: parked.id, revision: parked.revision });
    expect(resumed.lines[0]?.unitPricePaisa).toBe(15000);
    h.svc.inventory.adjust(h.admin, { productId: p.id, quantityDelta: -19, reason: 'count_correction', note: 'Counted one item' });
    expect(() => h.svc.sales.complete(h.cashier, { clientTxnId: resumed.id, lines: [{ productId: p.id, quantity: 2 }], expectedTotalPaisa: 30000, payment: { method: 'cash', tenderedPaisa: 30000 } })).toThrow(/Only 1/);
    expect(h.svc.carts.current(h.cashier)?.id).toBe(cart.id); // failed checkout rolls back cart completion
  });

  it('retires a cart atomically with payment and preserves transaction idempotency', () => {
    h = harness();
    const p = makeProduct(h);
    const cart = saveCart(p.id);
    const sale = payCart(cart);
    expect(h.svc.carts.current(h.cashier)).toBeNull();
    expect(payCart(cart).id).toBe(sale.id);
    expect(h.svc.products.get(p.id).qtyOnHand).toBe(p.qtyOnHand - 1);
    expect(() => h.svc.carts.save(h.cashier, { id: cart.id, revision: cart.revision, lines: [{ productId: p.id, quantity: 1 }], orderDiscountPaisa: 0 })).toThrow(/no longer active/);
  });

  it('rolls back the draft, stock and shift payment if checkout fails after payment insertion', () => {
    h = harness();
    const p = makeProduct(h);
    const cart = saveCart(p.id);
    const shift = h.svc.shifts.open(h.cashier, { openingPaisa: 1000 });
    h.db.exec("CREATE TRIGGER simulate_checkout_failure AFTER INSERT ON payments BEGIN SELECT RAISE(ABORT, 'Simulated failure'); END");
    expect(() => payCart(cart)).toThrow(/Simulated failure/);
    expect(h.svc.carts.current(h.cashier)?.id).toBe(cart.id);
    expect(h.svc.products.get(p.id).qtyOnHand).toBe(p.qtyOnHand);
    expect(h.svc.shifts.get(h.cashier, shift.id).expectedPaisa).toBe(1000);
    h.db.exec('DROP TRIGGER simulate_checkout_failure');
    const sale = payCart(cart);
    expect(sale.id).toBeGreaterThan(0);
    expect(h.svc.shifts.current()?.expectedPaisa).toBe(11000);
  });

  it('isolates cashiers and rejects stale updates, duplicate current carts and discarded-cart resurrection', () => {
    h = harness();
    const p = makeProduct(h);
    const cart = saveCart(p.id);
    expect(h.svc.carts.current(h.admin)).toBeNull();
    expect(h.svc.carts.list(h.admin)).toEqual([]);
    expect(() => h.svc.carts.discard(h.admin, { id: cart.id, revision: cart.revision })).toThrow(/another cashier/);
    expect(() => saveCart(p.id)).toThrow(/active cart/);
    const input = { id: cart.id, revision: cart.revision, lines: [{ productId: p.id, quantity: 2, discountPaisa: 0 }] };
    const updated = h.svc.carts.save(h.cashier, input);
    expect(h.svc.carts.save(h.cashier, input).revision).toBe(updated.revision); // save response retry
    expect(() => h.svc.carts.save(h.cashier, { ...input, lines: [{ productId: p.id, quantity: 3 }] })).toThrow(/changed elsewhere/);
    h.svc.carts.discard(h.cashier, { id: updated.id, revision: updated.revision });
    expect(() => h.svc.carts.save(h.cashier, { ...input, revision: updated.revision })).toThrow(/no longer active/);
  });
});
