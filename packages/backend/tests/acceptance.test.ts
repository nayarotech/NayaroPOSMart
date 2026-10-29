import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderLabelsHtml } from '../src/render/labels';
import { renderReceiptHtml } from '../src/render/receipt';
import { BackupService, restoreFile, verifyDatabaseFile } from '../src/services/backup';
import { openDatabase } from '../src/db/database';
import { gs1CheckDigit } from '../src/services/products';
import { ADMIN_PW, checkout, harness, makeProduct, tmpDir, type Harness } from './helpers';

let h: Harness;
afterEach(() => h?.close());

const ean = (stem: string) => stem + gs1CheckDigit(stem);

describe('1. products and internal barcodes', () => {
  it('creates a product with a unique NYM-###### SKU and Code 128 internal barcode', () => {
    h = harness();
    const a = makeProduct(h, { name: 'Rice 1 kg' });
    const b = makeProduct(h, { name: 'Rice 2 kg' });
    expect(a.sku).toMatch(/^NYM-\d{6}$/);
    expect(a.sku).not.toBe(b.sku);
    expect(a.barcodes).toHaveLength(1);
    expect(a.barcodes[0]).toMatchObject({ code: a.sku, symbology: 'CODE128', source: 'internal', isPrimary: true });
    // generating again is idempotent: no second internal barcode
    const again = h.svc.products.generateInternalBarcode(h.admin, a.id);
    expect(again.code).toBe(a.sku);
    expect(h.svc.products.get(a.id).barcodes).toHaveLength(1);
  });
});

describe('2. manufacturer barcodes', () => {
  it('registers an existing barcode, supports multiple per product, rejects duplicates and bad check digits', () => {
    h = harness();
    const code = ean('890123456789');
    const a = makeProduct(h, { barcode: code });
    expect(a.barcodes[0]).toMatchObject({ code, symbology: 'EAN13', source: 'manufacturer' });
    const b = makeProduct(h);
    expect(() => h.svc.products.addBarcode(h.admin, b.id, code)).toThrow(/already assigned to/);
    expect(() => h.svc.products.addBarcode(h.admin, b.id, '8901234567890'.slice(0, 12) + '9')).toThrow();
    const second = h.svc.products.addBarcode(h.admin, a.id, 'CASE-ABC-12');
    expect(second.symbology).toBe('CODE128');
    expect(h.svc.products.get(a.id).barcodes.map((x) => x.code).sort()).toEqual([code, 'CASE-ABC-12'].sort());
    // UNIQUE constraint at database level as a second line of defence
    expect(() => h.db.prepare("INSERT INTO product_barcodes (product_id, code, symbology, source, is_primary, created_at) VALUES (?, ?, 'EAN13', 'manufacturer', 0, 'x')").run(b.id, code)).toThrow(/UNIQUE/);
  });
});

describe('3. labels', () => {
  it('renders product stickers and shelf labels with real barcode SVG, NPR price and SKU', () => {
    h = harness();
    const p = makeProduct(h, { name: 'Mustard Oil 1 L', pricePaisa: 34000, barcode: ean('200000001234') });
    const s = h.svc.settings.get();
    const sticker = renderLabelsHtml('sticker', [{ product: p, copies: 3 }], s);
    expect(sticker.match(/class="label sticker"/g)).toHaveLength(3);
    expect(sticker).toContain('Rs. 340.00');
    expect(sticker).toContain(p.sku);
    expect(sticker).toMatch(/<svg[^>]*viewBox/);
    const shelf = renderLabelsHtml('shelf', [{ product: p, copies: 1 }], s);
    expect(shelf).toContain('class="label shelf"');
    expect(shelf).toContain('Mustard Oil 1 L');
    expect(shelf).toContain('Price as of');
  });

  it('flags labels as outdated after a price change', () => {
    h = harness();
    const p = makeProduct(h);
    h.svc.products.repo.markLabelsPrinted([p.id]);
    h.clock.advance(60_000);
    h.svc.products.update(h.admin, { id: p.id, name: p.name, categoryId: null, brand: null, unit: 'pcs', costPaisa: p.costPaisa, pricePaisa: 12000, minStock: 1, trackExpiry: false });
    expect(h.svc.products.get(p.id).labelOutdated).toBe(true);
  });
});

describe('4. scanning', () => {
  it('looks up by barcode or SKU and always returns the current database price', () => {
    h = harness();
    const code = ean('200000005555');
    const p = makeProduct(h, { barcode: code, pricePaisa: 5000 });
    expect(h.svc.products.lookupBarcode(code)?.pricePaisa).toBe(5000);
    expect(h.svc.products.lookupBarcode(`  ${code}\n`)?.id).toBe(p.id); // scanner Enter suffix / whitespace
    expect(h.svc.products.lookupBarcode(p.sku.toLowerCase())?.id).toBe(p.id);
    h.svc.products.update(h.admin, { id: p.id, name: p.name, categoryId: null, brand: null, unit: 'pcs', costPaisa: p.costPaisa, pricePaisa: 5500, minStock: 1, trackExpiry: false });
    expect(h.svc.products.lookupBarcode(code)?.pricePaisa).toBe(5500);
    expect(h.svc.products.lookupBarcode('0000000000000')).toBeNull();
    h.svc.products.setActive(h.admin, p.id, false);
    expect(h.svc.products.lookupBarcode(code)).toBeNull();
  });
});

describe('5. checkout', () => {
  it('completes a mixed-item sale with correct totals, payment, receipt, stock deduction and FY tag', () => {
    h = harness();
    const a = makeProduct(h, { pricePaisa: 12500, costPaisa: 10000, openingQty: 10 });
    const b = makeProduct(h, { pricePaisa: 4000, costPaisa: 3000, openingQty: 50 });
    const sale = checkout(h, h.cashier, [
      { productId: a.id, quantity: 2 },
      { productId: b.id, quantity: 3 },
      { productId: a.id, quantity: 1 }, // repeated scan of the same product merges into one line
    ], { tenderedPaisa: 100000 });
    expect(sale.items).toHaveLength(2);
    expect(sale.subtotalPaisa).toBe(3 * 12500 + 3 * 4000);
    expect(sale.totalPaisa).toBe(49500);
    expect(sale.payments[0]).toMatchObject({ kind: 'payment', method: 'cash', amountPaisa: 49500, tenderedPaisa: 100000, changePaisa: 50500 });
    expect(sale.receiptNo).toBe('NYM/83-84/000001');
    expect(sale.fiscalYear).toBe('2083/84');
    expect(h.svc.products.get(a.id).qtyOnHand).toBe(7);
    expect(h.svc.products.get(b.id).qtyOnHand).toBe(47);
    // ledger agrees with cached quantity
    expect(h.svc.inventory.stock.ledgerBalance(a.id)).toBe(7);
    const html = renderReceiptHtml(sale, h.svc.settings.get(), { dataMode: 'live' });
    expect(html).toContain('NYM/83-84/000001');
    expect(html).toContain('Rs. 495.00');
    expect(html).toContain('Not a tax invoice');
    const second = checkout(h, h.cashier, [{ productId: b.id, quantity: 1 }]);
    expect(second.receiptNo).toBe('NYM/83-84/000002');
  });

  it('rejects stale totals, insufficient stock and under-tendered cash', () => {
    h = harness();
    const a = makeProduct(h, { openingQty: 2 });
    expect(() => h.svc.sales.quote(h.cashier, { lines: [{ productId: a.id, quantity: 3 }] })).toThrow(/in stock/);
    const q = h.svc.sales.quote(h.cashier, { lines: [{ productId: a.id, quantity: 1 }] });
    const base = { lines: [{ productId: a.id, quantity: 1 }], clientTxnId: crypto.randomUUID(), payment: { method: 'cash', tenderedPaisa: q.totalPaisa } };
    expect(() => h.svc.sales.complete(h.cashier, { ...base, expectedTotalPaisa: q.totalPaisa - 1 })).toThrow(/Prices changed/);
    expect(() => h.svc.sales.complete(h.cashier, { ...base, expectedTotalPaisa: q.totalPaisa, payment: { method: 'cash', tenderedPaisa: 1 } })).toThrow(/less than the total/);
  });

  it('is idempotent on the client transaction id (double-click / retry cannot double-charge)', () => {
    h = harness();
    const a = makeProduct(h, { openingQty: 5 });
    const q = h.svc.sales.quote(h.cashier, { lines: [{ productId: a.id, quantity: 1 }] });
    const input = { lines: [{ productId: a.id, quantity: 1 }], clientTxnId: crypto.randomUUID(), expectedTotalPaisa: q.totalPaisa, payment: { method: 'cash', tenderedPaisa: q.totalPaisa } };
    const s1 = h.svc.sales.complete(h.cashier, input);
    const s2 = h.svc.sales.complete(h.cashier, input);
    expect(s2.id).toBe(s1.id);
    expect(h.svc.products.get(a.id).qtyOnHand).toBe(4);
  });
});

describe('6. atomicity', () => {
  it('rolls back sale, items, stock, ledger and receipt number if any step fails', () => {
    h = harness();
    const a = makeProduct(h, { openingQty: 10 });
    const b = makeProduct(h, { openingQty: 10 });
    const count = (t: string) => (h.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n;
    const before = { sales: count('sales'), items: count('sale_items'), moves: count('stock_movements'), pays: count('payments') };
    // Simulate a crash at the very last step (payment insert).
    h.db.exec("CREATE TEMP TRIGGER boom BEFORE INSERT ON payments BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;");
    expect(() => checkout(h, h.cashier, [{ productId: a.id, quantity: 2 }, { productId: b.id, quantity: 3 }])).toThrow(/simulated failure/);
    expect({ sales: count('sales'), items: count('sale_items'), moves: count('stock_movements'), pays: count('payments') }).toEqual(before);
    expect(h.svc.products.get(a.id).qtyOnHand).toBe(10);
    expect(h.svc.products.get(b.id).qtyOnHand).toBe(10);
    h.db.exec('DROP TRIGGER boom');
    // The failed attempt did not consume a receipt number.
    expect(checkout(h, h.cashier, [{ productId: a.id, quantity: 1 }]).receiptNo).toBe('NYM/83-84/000001');
  });
});

describe('7. offline and restart', () => {
  it('completes a sale with all network access failing, and the data survives a restart', () => {
    h = harness();
    const fetchSpy = vi.fn(() => {
      throw new Error('network disabled');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const a = makeProduct(h, { openingQty: 4 });
    const sale = checkout(h, h.cashier, [{ productId: a.id, quantity: 1 }]);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    h = h.reopen(); // simulates closing and restarting the app
    expect(h.svc.sales.get(sale.id).receiptNo).toBe(sale.receiptNo);
    expect(h.svc.products.get(a.id).qtyOnHand).toBe(3);
    expect(h.db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(h.db.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});

describe('8. purchases', () => {
  it('receives a purchase transactionally, increases stock, records cost and blocks re-receiving the same invoice', () => {
    h = harness();
    const a = makeProduct(h, { openingQty: 0, costPaisa: 8000 });
    const s = h.svc.purchases.createSupplier(h.admin, { name: 'Test Supplier (fictional)' });
    const input = { supplierId: s.id, invoiceNo: 'INV-1', invoiceDate: '2026-10-27', items: [{ productId: a.id, quantity: 24, unitCostPaisa: 8500, batchNo: 'B1', expiryDate: '2027-01-01' }] };
    const pur = h.svc.purchases.receive(h.admin, input);
    expect(pur.totalPaisa).toBe(24 * 8500);
    expect(pur.fiscalYear).toBe('2083/84');
    expect(h.svc.products.get(a.id).qtyOnHand).toBe(24);
    expect(h.svc.products.get(a.id).costPaisa).toBe(8500);
    expect(h.svc.inventory.movements({ productId: a.id }).rows[0]).toMatchObject({ type: 'purchase', quantityDelta: 24, balanceAfter: 24 });
    expect(() => h.svc.purchases.receive(h.admin, input)).toThrow(/already received/);
    expect(h.svc.products.get(a.id).qtyOnHand).toBe(24);
  });
});

describe('9. voids and returns', () => {
  it('records partial returns with refund and audit, blocks excessive returns', () => {
    h = harness();
    const a = makeProduct(h, { pricePaisa: 10000, openingQty: 10 });
    const sale = checkout(h, h.admin, [{ productId: a.id, quantity: 3 }]);
    const item = sale.items[0]!;
    const r1 = h.svc.sales.createReturn(h.admin, { saleId: sale.id, items: [{ saleItemId: item.id, quantity: 2 }], reason: 'Customer changed mind', restock: true });
    expect(r1.status).toBe('partially_returned');
    expect(r1.returns[0]!.refundPaisa).toBe(20000);
    expect(h.svc.products.get(a.id).qtyOnHand).toBe(9);
    expect(() => h.svc.sales.createReturn(h.admin, { saleId: sale.id, items: [{ saleItemId: item.id, quantity: 2 }], reason: 'Trying too many', restock: true })).toThrow(/only 1 left/);
    const r2 = h.svc.sales.createReturn(h.admin, { saleId: sale.id, items: [{ saleItemId: item.id, quantity: 1 }], reason: 'Damaged item', restock: false });
    expect(r2.status).toBe('returned');
    expect(r2.returns.reduce((s, r) => s + r.refundPaisa, 0)).toBe(sale.totalPaisa);
    expect(h.svc.products.get(a.id).qtyOnHand).toBe(9); // damaged item not restocked
    expect(() => h.svc.sales.void(h.admin, { saleId: sale.id, reason: 'Should not be allowed' })).toThrow();
    const audit = h.svc.audit.list({ page: 1, pageSize: 50, action: 'sale.returned' });
    expect(audit.total).toBe(2);
  });

  it('voids a sale with reason, reverses stock, keeps the sale and logs who approved', () => {
    h = harness();
    const a = makeProduct(h, { openingQty: 5 });
    const sale = checkout(h, h.cashier, [{ productId: a.id, quantity: 2 }]);
    expect(() => h.svc.sales.void(h.cashier, { saleId: sale.id, reason: 'Wrong item scanned' })).toThrow(/approval/);
    expect(() => h.svc.sales.void(h.cashier, { saleId: sale.id, reason: 'Wrong item scanned', override: { username: 'till', password: 'Cashier-pass-1' } })).toThrow(/administrator/);
    const v = h.svc.sales.void(h.cashier, { saleId: sale.id, reason: 'Wrong item scanned', override: { username: 'boss', password: ADMIN_PW } });
    expect(v.status).toBe('voided');
    expect(v.voidReason).toBe('Wrong item scanned');
    expect(h.svc.products.get(a.id).qtyOnHand).toBe(5);
    const log = h.svc.audit.list({ page: 1, pageSize: 5, action: 'sale.voided' }).rows[0]!;
    expect(log.userName).toBe('Test Cashier');
    expect(log.approvedByName).toBe('Test Admin');
    expect(() => h.db.prepare('DELETE FROM sales WHERE id = ?').run(sale.id)).toThrow(/cannot be deleted/);
  });
});

describe('10. historical prices', () => {
  it('keeps old sale prices after a product price change and blocks tampering', () => {
    h = harness();
    const a = makeProduct(h, { pricePaisa: 10000, costPaisa: 7000, openingQty: 10 });
    const sale = checkout(h, h.cashier, [{ productId: a.id, quantity: 1 }]);
    h.svc.products.update(h.admin, { id: a.id, name: a.name, categoryId: null, brand: null, unit: 'pcs', costPaisa: 7500, pricePaisa: 15000, minStock: 1, trackExpiry: false, priceChangeReason: 'Supplier increase' });
    const after = h.svc.sales.get(sale.id);
    expect(after.items[0]).toMatchObject({ unitPricePaisa: 10000, unitCostPaisa: 7000 });
    expect(after.totalPaisa).toBe(10000);
    expect(h.svc.products.get(a.id).priceHistory.map((p) => p.pricePaisa)).toEqual([15000, 10000]);
    expect(() => h.db.prepare('UPDATE sale_items SET unit_price_paisa = 1 WHERE sale_id = ?').run(sale.id)).toThrow(/immutable/);
    expect(() => h.db.prepare('UPDATE sales SET total_paisa = 1 WHERE id = ?').run(sale.id)).toThrow(/immutable/);
    expect(h.svc.audit.list({ page: 1, pageSize: 5, action: 'product.price_changed' }).total).toBe(1);
  });
});

describe('11. backup and restore', () => {
  it('creates verified backups that never overwrite each other and restores onto a separate copy', () => {
    h = harness();
    const a = makeProduct(h, { openingQty: 3 });
    checkout(h, h.cashier, [{ productId: a.id, quantity: 1 }]);
    const backupDir = tmpDir('srmart-backups-');
    const svc = new BackupService(() => h.db, h.file, () => backupDir);
    const t = new Date(2026, 9, 28, 12, 0, 0);
    const b1 = svc.create('manual', t);
    const b2 = svc.create('manual', t); // same second: must get a different name
    expect(b1.file).not.toBe(b2.file);
    expect(b1.verified).toBe(true);
    expect(fs.existsSync(b1.path) && fs.existsSync(b2.path)).toBe(true);

    // later sale that is NOT in the backup
    checkout(h, h.cashier, [{ productId: a.id, quantity: 1 }]);

    const test = svc.testRestore(b1.file);
    expect(test.ok).toBe(true);
    expect(test.tables.sales).toBe(1);

    // full restore onto a separate copy of the primary database
    const copyDir = tmpDir('srmart-restore-');
    const copy = path.join(copyDir, 'srmart.sqlite');
    fs.copyFileSync(h.file, copy);
    restoreFile(copy, b1.path);
    const restored = openDatabase(copy);
    expect((restored.prepare('SELECT COUNT(*) n FROM sales').get() as { n: number }).n).toBe(1);
    restored.close();
    expect(verifyDatabaseFile(copy).ok).toBe(true);

    expect(() => svc.verify('../../etc/passwd')).toThrow(/Invalid backup file name/);
    expect(() => new BackupService(() => h.db, h.file, () => path.dirname(h.file)).create()).toThrow(/different from the database folder/);
  });

  it('retention never deletes the newest verified backup', () => {
    h = harness();
    const dir = tmpDir('srmart-backups-');
    const svc = new BackupService(() => h.db, h.file, () => dir);
    for (let i = 0; i < 5; i++) svc.create('auto', new Date(2026, 9, 28, 12, 0, i));
    svc.prune(3);
    expect(svc.list()).toHaveLength(3);
    expect(svc.list()[0]!.verified).toBe(true);
  });
});

describe('12. cashier permissions', () => {
  it('blocks restricted actions and requires admin approval for large discounts', () => {
    h = harness();
    const a = makeProduct(h, { pricePaisa: 10000, openingQty: 10 });
    const c = h.cashier;
    expect(() => h.svc.products.create(c, { name: 'Nope', categoryId: null, costPaisa: 1, pricePaisa: 2, minStock: 0 })).toThrow(/permission/);
    expect(() => h.svc.products.update(c, { id: a.id, name: a.name, categoryId: null, brand: null, unit: 'pcs', costPaisa: 1, pricePaisa: 1, minStock: 0, trackExpiry: false })).toThrow(/permission/);
    expect(() => h.svc.inventory.adjust(c, { productId: a.id, quantityDelta: 5, reason: 'other', note: 'test' })).toThrow(/permission/);
    expect(() => h.svc.settings.update(c, h.svc.settings.get())).toThrow(/permission/);
    expect(() => h.svc.users.list(c)).toThrow(/permission/);
    expect(() => h.svc.purchases.createSupplier(c, { name: 'X Supplier' })).toThrow(/permission/);
    // 5% allowed, 20% needs approval
    expect(checkout(h, c, [{ productId: a.id, quantity: 1, discountPaisa: 500 }]).discountPaisa).toBe(500);
    expect(() => checkout(h, c, [{ productId: a.id, quantity: 1, discountPaisa: 2000 }])).toThrow(/approval/);
    const ok = checkout(h, c, [{ productId: a.id, quantity: 1, discountPaisa: 2000 }], { override: { username: 'boss', password: ADMIN_PW } });
    expect(ok.discountApprovedBy).toBe('Test Admin');
    expect(h.svc.audit.list({ page: 1, pageSize: 10, action: 'sale.discount' }).total).toBe(2);
  });
});

describe('13. fiscal year', () => {
  it('tags sales by Nepal fiscal year (1 Shrawan) and restarts receipt numbering each year', () => {
    h = harness({ now: new Date(2026, 6, 15, 10) }); // 15 Jul 2026 → still FY 2082/83
    const a = makeProduct(h, { openingQty: 10 });
    const old = checkout(h, h.cashier, [{ productId: a.id, quantity: 1 }]);
    expect(old.fiscalYear).toBe('2082/83');
    h.clock.set(new Date(2026, 6, 17, 10)); // 17 Jul 2026 = 1 Shrawan 2083
    const fresh = checkout(h, h.cashier, [{ productId: a.id, quantity: 1 }]);
    expect(fresh.fiscalYear).toBe('2083/84');
    expect(fresh.receiptNo).toBe('NYM/83-84/000001');
    const fy = h.svc.fiscal.current();
    expect(fy).toMatchObject({ code: '2083/84', startDate: '2026-07-17', dayNumber: 1 });
    expect(fy.endDate).toBe('2027-07-16');
    expect(h.svc.fiscal.list().map((f) => f.code)).toEqual(expect.arrayContaining(['2083/84', '2082/83']));
  });
});

describe('14. compliance gate and CSV', () => {
  it('refuses to enable tax until verified with a note', () => {
    h = harness();
    const s = h.svc.settings.get();
    expect(() => h.svc.settings.update(h.admin, { ...s, tax: { ...s.tax, enabled: true, rateBp: 1300, label: 'VAT' } })).toThrow(/verified/);
    const q = h.svc.sales.quote(h.admin, { lines: [{ productId: makeProduct(h).id, quantity: 1 }] });
    expect(q.taxPaisa).toBe(0);
  });

  it('imports CSV with duplicate and error reporting, dry-run first', () => {
    h = harness();
    makeProduct(h, { barcode: ean('200000009999') });
    const csv = [
      'name,category,unit,cost_price,selling_price,qty_on_hand,min_stock,barcode',
      'Good One,Groceries,pkt,10,15,5,1,',
      `Dup Existing,Groceries,pkt,10,15,5,1,${ean('200000009999')}`,
      'Bad Price,Groceries,pkt,10,abc,5,1,',
      `With EAN,Cosmetics,pcs,50,80,2,1,${ean('200000008888')}`,
      `Dup In File,Cosmetics,pcs,50,80,2,1,${ean('200000008888')}`,
    ].join('\n');
    const dry = h.svc.products.importCsv(h.admin, csv, false);
    expect(dry).toMatchObject({ committed: false, ok: 2, duplicates: 2, errors: 1 });
    expect(h.svc.products.list({ q: 'Good One' }).total).toBe(0);
    const done = h.svc.products.importCsv(h.admin, csv, true);
    expect(done.committed).toBe(true);
    expect(h.svc.products.list({ q: 'Good One' }).rows[0]!.qtyOnHand).toBe(5);
    expect(h.svc.products.lookupBarcode(ean('200000008888'))?.name).toBe('With EAN');
    const out = h.svc.products.exportCsv();
    expect(out.csv.split('\n')[0]).toContain('selling_price');
    expect(out.count).toBe(3);
  });
});
