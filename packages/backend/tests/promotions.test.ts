import crypto from 'node:crypto';
import https from 'node:https';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ScannerServer } from '../src/api/scannerServer';
import { ensureCertificate } from '../src/api/tls';
import { renderReceiptHtml } from '../src/render/receipt';
import { couponsFor } from '../src/services/promotions';
import { harness, makeProduct, tmpDir, type Harness, ADMIN_PW } from './helpers';

let h: Harness;
afterEach(() => h?.close());

function sell(user: Harness['admin'], lines: { productId: number; quantity: number; discountPaisa?: number }[], extra: { customer?: { name: string; phone: string; consent: true }; override?: { username: string; password: string } } = {}) {
  const l = lines.map((x) => ({ discountPaisa: 0, ...x }));
  const q = h.svc.sales.quote(user, { lines: l });
  const sale = h.svc.sales.complete(user, {
    lines: l,
    clientTxnId: crypto.randomUUID(),
    expectedTotalPaisa: q.totalPaisa,
    payment: { method: 'cash', tenderedPaisa: q.totalPaisa },
    customer: extra.customer ?? null,
    override: extra.override ?? null,
  });
  return { q, sale };
}

describe('festival discounts', () => {
  it('applies the best running promotion automatically and records it on the sale', () => {
    h = harness();
    const cat = h.svc.products.createCategory(h.admin, 'Clothing');
    const shirt = h.svc.products.create(h.admin, { name: 'Shirt', categoryId: cat.id, costPaisa: 40000, pricePaisa: 100000, minStock: 0, openingQty: 10 });
    const rice = makeProduct(h, { pricePaisa: 50000, openingQty: 10 });
    h.svc.promotions.createPromotion(h.admin, { name: 'Dashain offer', percentBp: 1000, categoryId: null, startsOn: '2026-10-01', endsOn: '2026-10-31' });
    h.svc.promotions.createPromotion(h.admin, { name: 'Clothing fest', percentBp: 2000, categoryId: cat.id, startsOn: '2026-10-20', endsOn: '2026-11-05' });
    h.svc.promotions.createPromotion(h.admin, { name: 'Future', percentBp: 5000, categoryId: null, startsOn: '2026-12-01', endsOn: '2026-12-31' });

    const { q, sale } = sell(h.cashier, [{ productId: shirt.id, quantity: 1 }, { productId: rice.id, quantity: 2 }]);
    const shirtLine = q.lines.find((l) => l.productId === shirt.id)!;
    const riceLine = q.lines.find((l) => l.productId === rice.id)!;
    expect(shirtLine).toMatchObject({ promoDiscountPaisa: 20000, promotionName: 'Clothing fest 20%' }); // best of 10% and 20%
    expect(riceLine).toMatchObject({ promoDiscountPaisa: 10000, promotionName: 'Dashain offer 10%' });
    expect(q.totalPaisa).toBe(200000 - 30000);
    expect(q.discountRequiresApproval).toBe(false); // admin-scheduled promos don't need cashier approval
    expect(sale.promoDiscountPaisa).toBe(30000);
    expect(sale.items.find((i) => i.productId === shirt.id)).toMatchObject({ promoDiscountPaisa: 20000, lineTotalPaisa: 80000 });
    const html = renderReceiptHtml(sale, h.svc.settings.get(), { dataMode: 'live' });
    expect(html).toContain('Clothing fest 20%');
    expect(html).toContain('You saved');
    // reports break promotions out
    const rep = h.svc.reports.salesReport({ from: '2026-10-28', to: '2026-10-28' });
    expect(rep.promotions.map((p) => p.name).sort()).toEqual(['Clothing fest 20%', 'Dashain offer 10%']);
    // the promotion stops applying after it ends
    h.clock.set(new Date(2026, 11, 15, 10));
    expect(h.svc.sales.quote(h.cashier, { lines: [{ productId: rice.id, quantity: 1 }] }).lines[0]).toMatchObject({ promoDiscountPaisa: 25000, promotionName: 'Future 50%' });
  });

  it('only admins can create promotions and invalid ranges are rejected', () => {
    h = harness();
    expect(() => h.svc.promotions.createPromotion(h.cashier, { name: 'Sneaky', percentBp: 9000, categoryId: null, startsOn: '2026-10-01', endsOn: '2026-10-31' })).toThrow(/permission/);
    expect(() => h.svc.promotions.createPromotion(h.admin, { name: 'Backwards', percentBp: 1000, categoryId: null, startsOn: '2026-10-31', endsOn: '2026-10-01' })).toThrow(/End date/);
    expect(() => h.svc.promotions.createPromotion(h.admin, { name: 'Too much', percentBp: 9500, categoryId: null, startsOn: '2026-10-01', endsOn: '2026-10-31' })).toThrow(/90%/);
  });
});

describe('lucky-draw schemes', () => {
  it('computes coupons per bill', () => {
    expect(couponsFor(199999, 200000, 100000)).toBe(0);
    expect(couponsFor(200000, 200000, 100000)).toBe(1);
    expect(couponsFor(500000, 200000, 100000)).toBe(4);
    expect(couponsFor(900000, 200000, null)).toBe(1);
  });

  it('issues coupons with customer consent inside the sale, prints them, and excludes voided sales from the draw', () => {
    h = harness();
    const tv = makeProduct(h, { pricePaisa: 150000, openingQty: 20 });
    const scheme = h.svc.promotions.createScheme(h.admin, { name: 'Tihar Lucky Draw', minBillPaisa: 200000, entryStepPaisa: 100000, startsOn: '2026-10-20', endsOn: '2026-11-10', couponPrefix: 'TIHAR' });

    const small = sell(h.cashier, [{ productId: tv.id, quantity: 1 }]);
    expect(small.q.qualifyingSchemes).toEqual([]);
    expect(small.q.nearSchemes[0]).toMatchObject({ name: 'Tihar Lucky Draw', shortByPaisa: 50000 });

    const big = sell(h.cashier, [{ productId: tv.id, quantity: 4 }], { customer: { name: 'Sita Example', phone: '98-0000 0001', consent: true } });
    expect(big.q.qualifyingSchemes).toEqual([{ id: scheme.id, name: 'Tihar Lucky Draw', minBillPaisa: 200000, coupons: 5 }]); // Rs 6,000
    expect(big.sale.coupons.map((c) => c.couponNo)).toEqual(['TIHAR-00001', 'TIHAR-00002', 'TIHAR-00003', 'TIHAR-00004', 'TIHAR-00005']);
    expect(big.sale.customer).toMatchObject({ name: 'Sita Example', phone: '9800000001' });
    const html = renderReceiptHtml(big.sale, h.svc.settings.get(), { dataMode: 'live' });
    expect(html).toContain('LUCKY DRAW COUPONS');
    expect(html).toContain('TIHAR-00003');
    expect(html).not.toContain('9800000001'); // phone is masked on paper

    // A customer who declines: no customer stored, no coupons
    const declined = sell(h.cashier, [{ productId: tv.id, quantity: 2 }]);
    expect(declined.sale.coupons).toEqual([]);
    // consent must be explicit
    expect(() => h.svc.sales.complete(h.cashier, { lines: [{ productId: tv.id, quantity: 2 }], clientTxnId: crypto.randomUUID(), expectedTotalPaisa: 300000, payment: { method: 'cash', tenderedPaisa: 300000 }, customer: { name: 'No Consent', phone: '9800000002', consent: false } })).toThrow(/agree/);

    const second = sell(h.cashier, [{ productId: tv.id, quantity: 2 }], { customer: { name: 'Ram Example', phone: '9800000003', consent: true } });
    expect(second.sale.coupons).toHaveLength(2); // Rs 3,000 = 1 + 1 step
    // void the second sale -> its coupons are no longer eligible
    h.svc.sales.void(h.admin, { saleId: second.sale.id, reason: 'Testing coupon eligibility' });
    const detail = h.svc.promotions.getScheme(scheme.id);
    expect(detail.couponCount).toBe(7);
    expect(detail.eligibleCouponCount).toBe(5);

    // coupons cannot be tampered with
    expect(() => h.db.prepare("UPDATE scheme_entries SET coupon_no = 'X'").run()).toThrow(/cannot be changed/);
    expect(() => h.db.prepare('DELETE FROM scheme_entries').run()).toThrow(/cannot be deleted/);

    // draw: blocked before the end unless confirmed, cashiers can't draw, winners are unique and eligible
    expect(() => h.svc.promotions.draw(h.admin, { schemeId: scheme.id, prize: 'Rice bag', count: 1 })).toThrow(/runs until/);
    expect(() => h.svc.promotions.draw(h.cashier, { schemeId: scheme.id, prize: 'Rice bag', count: 1, allowBeforeEnd: true })).toThrow(/permission/);
    h.clock.set(new Date(2026, 10, 11, 10)); // after the scheme ended
    const first = h.svc.promotions.draw(h.admin, { schemeId: scheme.id, prize: 'First prize: TV', count: 1 });
    const more = h.svc.promotions.draw(h.admin, { schemeId: scheme.id, prize: 'Consolation', count: 4 });
    const all = [...first, ...more];
    expect(all.map((w) => w.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(all.map((w) => w.couponNo)).size).toBe(5);
    expect(all.every((w) => w.customerName === 'Sita Example')).toBe(true); // Ram's coupon was voided
    expect(first[0]!.poolSize).toBe(5);
    expect(() => h.svc.promotions.draw(h.admin, { schemeId: scheme.id, prize: 'More', count: 1 })).toThrow(/Only 0 eligible/);
    expect(h.svc.audit.list({ page: 1, pageSize: 10, action: 'scheme.draw' }).total).toBe(2);

    // returning customer lookup and the customer list
    expect(h.svc.promotions.lookupCustomer('9800000001')?.couponCount).toBe(5);
    expect(h.svc.promotions.customers(h.admin, {}).total).toBe(2);
    expect(() => h.svc.promotions.customers(h.cashier, {})).toThrow(/permission/);
  });

  it('locks coupon rules once coupons exist and keeps prefixes unique', () => {
    h = harness();
    const p = makeProduct(h, { pricePaisa: 300000, openingQty: 5 });
    const base = { name: 'Draw A', minBillPaisa: 200000, entryStepPaisa: null, startsOn: '2026-10-01', endsOn: '2026-11-30', couponPrefix: 'DRAWA' };
    const s = h.svc.promotions.createScheme(h.admin, base);
    expect(() => h.svc.promotions.createScheme(h.admin, { ...base, name: 'Draw B' })).toThrow(/already used/);
    sell(h.admin, [{ productId: p.id, quantity: 1 }], { customer: { name: 'Hari Example', phone: '9800000004', consent: true } });
    expect(() => h.svc.promotions.updateScheme(h.admin, { ...base, id: s.id, minBillPaisa: 100000 })).toThrow(/can no longer change/);
    expect(h.svc.promotions.updateScheme(h.admin, { ...base, id: s.id, name: 'Draw A (renamed)', endsOn: '2026-12-15' }).name).toBe('Draw A (renamed)');
  });
});

describe('phone scanner server', () => {
  function req(port: number, method: string, p: string, body?: unknown, token?: string): Promise<{ status: number; json: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const r = https.request(
        { host: '127.0.0.1', port, path: p, method, rejectUnauthorized: false, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } },
        (res) => {
          let d = '';
          res.on('data', (c) => (d += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, json: d.startsWith('{') ? JSON.parse(d) : {} }));
        },
      );
      r.on('error', reject);
      if (body) r.write(JSON.stringify(body));
      r.end();
    });
  }

  it('pairs with a single-use QR token over HTTPS and forwards scans', async () => {
    const tls = await ensureCertificate(path.join(tmpDir(), 'certs'));
    expect(tls.cert).toContain('BEGIN CERTIFICATE');
    const scans: string[] = [];
    const port = 19000 + Math.floor(Math.random() * 1000);
    const server = new ScannerServer({
      port,
      host: '127.0.0.1',
      tls,
      staticDir: null,
      storeName: () => 'Nayaro Mart',
      onScan: (code) => (scans.push(code), { ok: true, message: 'Added', product: { name: 'Rice', pricePaisa: 97500 }, delivered: true }),
    });
    await server.start();
    try {
      expect((await req(port, 'POST', '/api/scan', { code: '2000000010007' })).status).toBe(401);
      expect((await req(port, 'POST', '/api/pair', { pairToken: 'guess' })).status).toBe(401);
      const { token } = server.startPairing();
      const paired = await req(port, 'POST', '/api/pair', { pairToken: token, deviceName: 'Owner phone' });
      expect(paired.status).toBe(200);
      const deviceToken = String(paired.json.deviceToken);
      expect((await req(port, 'POST', '/api/pair', { pairToken: token })).status).toBe(401); // single use
      const scan = await req(port, 'POST', '/api/scan', { code: '2000000010007' }, deviceToken);
      expect(scan.json).toMatchObject({ ok: true, delivered: true, product: { name: 'Rice' } });
      expect((await req(port, 'POST', '/api/scan', { code: 'has space' }, deviceToken)).status).toBe(400);
      expect(scans).toEqual(['2000000010007']);
      expect(server.listDevices()[0]).toMatchObject({ name: 'Owner phone', scans: 1 });
      expect((await req(port, 'GET', '/index.html')).status).toBe(404); // admin dashboard is not served here
      server.unpair(server.listDevices()[0]!.id);
      expect((await req(port, 'POST', '/api/scan', { code: '2000000010007' }, deviceToken)).status).toBe(401);
    } finally {
      await server.stop();
    }
  });
});

void ADMIN_PW;
