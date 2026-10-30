import path from 'node:path';
import https from 'node:https';
import { ensureCertificate } from '../src/api/tls';
import { afterEach, describe, expect, it } from 'vitest';
import { FixedClock } from '../src/clock';
import { openDatabase, type DB } from '../src/db/database';
import { createServices } from '../src/services';
import { toSession } from '../src/services/auth';
import { UserRepo } from '../src/repositories/userRepo';
import { SettingsRepo } from '../src/repositories/settingsRepo';
import { DEMO_USERS, seedDemoData } from '../src/seed/demo';
import { MobileServer } from '../src/api/mobileServer';
import { CONFIRM_DELETE_REAL, CONFIRM_GO_LIVE, CONFIRM_RESET_DEMO } from '../src/services/demo';
import { tmpDir } from './helpers';

const NOW = new Date(2026, 9, 28, 15, 0, 0);
let db: DB;
afterEach(() => db?.open && db.close());

function seeded() {
  db = openDatabase(path.join(tmpDir(), 'demo.sqlite'));
  seedDemoData(db, NOW);
  const ctx = { db, clock: new FixedClock(NOW) };
  const svc = createServices(ctx);
  const users = new UserRepo(ctx);
  return { svc, ctx, admin: toSession(users.byUsername('admin')!), cashier: toSession(users.byUsername('cashier')!) };
}

describe('demo data', () => {
  it('seeds clearly-flagged fictional data across categories with sales in two fiscal years', () => {
    const { svc } = seeded();
    const products = svc.products.list({ pageSize: 200 }).rows;
    expect(products.length).toBeGreaterThanOrEqual(40);
    expect(products.every((p) => p.isDemo)).toBe(true);
    expect(new Set(products.map((p) => p.categoryName))).toEqual(new Set(['Groceries', 'Packaged Foods', 'Cosmetics', 'Clothing', 'Household']));
    expect(products.some((p) => p.barcodes.some((b) => b.source === 'manufacturer' && b.code.startsWith('20')))).toBe(true);
    expect(products.some((p) => p.barcodes.some((b) => b.source === 'internal'))).toBe(true);
    expect(svc.inventory.lowStock().length).toBeGreaterThan(3);
    const fys = svc.fiscal.list();
    expect(fys.find((f) => f.code === '2083/84')?.saleCount).toBeGreaterThan(50);
    expect(fys.find((f) => f.code === '2082/83')?.saleCount).toBeGreaterThan(0);
    const dash = svc.reports.dashboard();
    expect(dash.dataMode).toBe('demo');
    expect(dash.fiscal.code).toBe('2083/84');
    expect(dash.today.salesCount).toBeGreaterThan(0);
    expect(dash.today.demoSalesCount).toBe(dash.today.salesCount);
    expect(dash.outdatedLabelCount).toBe(1);
    // demo festival offer + lucky draw with fictional customers
    expect(svc.promotions.listPromotions()[0]).toMatchObject({ name: 'Tihar offer (Demo)', state: 'running', isDemo: true });
    const scheme = svc.promotions.listSchemes()[0]!;
    expect(scheme).toMatchObject({ name: 'Tihar Lucky Draw (Demo)', state: 'running' });
    expect(scheme.couponCount).toBeGreaterThan(5);
    expect(scheme.customerCount).toBe(4);
    // every product's cached quantity equals its stock ledger
    for (const p of products) expect(svc.inventory.stock.ledgerBalance(p.id)).toBe(p.qtyOnHand);
    const rep = svc.reports.salesReport({ from: dash.fiscal.startDate, to: dash.fiscal.todayAd, groupBy: 'month' });
    expect(rep.buckets.map((b) => b.label)).toEqual(expect.arrayContaining(['Kartik 2083']));
    expect(rep.totals.estimatedMarginPaisa).toBeGreaterThan(0);
    expect(rep.totals.estimatedMarginPaisa).toBeLessThan(rep.totals.netSalesPaisa);
  });

  it('reset requires the admin password and a typed confirmation; real data needs a stronger one', () => {
    const { svc, admin, cashier, ctx } = seeded();
    expect(() => svc.demo.checkReset(cashier, CONFIRM_RESET_DEMO, DEMO_USERS[1]!.password)).toThrow(/permission/);
    expect(() => svc.demo.checkReset(admin, CONFIRM_RESET_DEMO, 'wrong')).toThrow(/Incorrect/);
    expect(() => svc.demo.checkReset(admin, 'yes', DEMO_USERS[0]!.password)).toThrow(/Type/);
    expect(svc.demo.checkReset(admin, CONFIRM_RESET_DEMO, DEMO_USERS[0]!.password).real).toBe(0);
    // Switch to live and record a real product: now the weak confirmation is refused.
    svc.demo.checkGoLive(admin, CONFIRM_GO_LIVE, DEMO_USERS[0]!.password);
    svc.demo.applyGoLive(admin, 'test-backup.sqlite');
    expect(new SettingsRepo(ctx).getDataMode()).toBe('live');
    expect(svc.products.list({}).total).toBe(0);
    expect(svc.audit.list({ page: 1, pageSize: 5 }).total).toBeGreaterThan(0); // audit history kept
    svc.products.create(admin, { name: 'Real product', categoryId: null, costPaisa: 100, pricePaisa: 200, minStock: 0 });
    expect(() => svc.demo.checkReset(admin, CONFIRM_RESET_DEMO, DEMO_USERS[0]!.password)).toThrow(new RegExp(CONFIRM_DELETE_REAL));
    expect(svc.demo.checkReset(admin, CONFIRM_DELETE_REAL, DEMO_USERS[0]!.password).real).toBe(1);
  });
});

describe('mobile admin API', () => {
  it('lets admins read the summary, rejects cashiers, and is read-only', async () => {
    const { svc } = seeded();
    const port = 18000 + Math.floor(Math.random() * 1000);
    const tls = await ensureCertificate(path.join(tmpDir(), 'certs'));
    const server = new MobileServer({ services: () => svc, staticDir: null, port, host: '127.0.0.1', tls });
    await server.start();
    const base = `https://127.0.0.1:${port}`;
    const fetch = (url: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; json: () => Promise<unknown> }> => new Promise((resolve, reject) => {
      const request = https.request(url, { ...opts, rejectUnauthorized: false }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: async () => JSON.parse(body) }));
      });
      request.on('error', reject);
      request.end(opts.body);
    });
    try {
      const post = (u: string, body: unknown) => fetch(base + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      expect((await post('/api/login', { username: 'cashier', password: DEMO_USERS[1]!.password })).status).toBe(403);
      expect((await post('/api/login', { username: 'admin', password: 'nope' })).status).toBe(401);
      expect((await fetch(`${base}/api/summary`)).status).toBe(401);
      const login = await post('/api/login', { username: 'admin', password: DEMO_USERS[0]!.password });
      expect(login.status).toBe(200);
      const { token } = (await login.json()) as { token: string };
      const auth = { headers: { Authorization: `Bearer ${token}` } };
      const sum = (await (await fetch(`${base}/api/summary`, auth)).json()) as { fiscal: { code: string }; dataMode: string; today: { salesCount: number } };
      expect(sum.fiscal.code).toBe('2083/84');
      expect(sum.dataMode).toBe('demo');
      expect(sum.today.salesCount).toBeGreaterThan(0);
      const sales = (await (await fetch(`${base}/api/sales?date=2026-10-28`, auth)).json()) as { rows: { id: number }[] };
      expect(sales.rows.length).toBeGreaterThan(0);
      expect((await fetch(`${base}/api/sales/${sales.rows[0]!.id}`, auth)).status).toBe(200);
      expect((await fetch(`${base}/api/sales`, { method: 'DELETE', ...auth })).status).toBe(405);
      // A changed credential invalidates existing tokens even if the account stays active.
      svc.auth.changePassword(svc.auth.login({ username: 'admin', password: DEMO_USERS[0]!.password }), DEMO_USERS[0]!.password, 'Changed-password-1');
      expect((await fetch(`${base}/api/summary`, auth)).status).toBe(401);
      const second = await post('/api/login', { username: 'admin', password: 'Changed-password-1' });
      const nextToken = (await second.json() as { token: string }).token;
      expect((await post('/api/logout', {})).status).toBe(200);
      const nextAuth = { headers: { Authorization: `Bearer ${nextToken}` } };
      expect((await fetch(`${base}/api/logout`, { method: 'POST', ...nextAuth })).status).toBe(200);
      expect((await fetch(`${base}/api/summary`, nextAuth)).status).toBe(401);
      db.prepare("UPDATE users SET must_change_password = 1 WHERE username = 'admin'").run();
      expect((await post('/api/login', { username: 'admin', password: 'Changed-password-1' })).status).toBe(403);

    } finally {
      await server.stop();
    }
  });
});
