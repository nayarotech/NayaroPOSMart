import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionUser } from '@srmart/shared';
import { FixedClock } from '../src/clock';
import { openDatabase, type DB } from '../src/db/database';
import { createServices, type Services } from '../src/services';
import { hashPassword, toSession } from '../src/services/auth';
import { UserRepo } from '../src/repositories/userRepo';
import { SettingsRepo } from '../src/repositories/settingsRepo';

export function tmpDir(prefix = 'srmart-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export interface Harness {
  db: DB;
  file: string;
  dir: string;
  clock: FixedClock;
  svc: Services;
  admin: SessionUser;
  cashier: SessionUser;
  reopen(): Harness;
  close(): void;
}

export const ADMIN_PW = 'Admin-pass-1';
export const CASHIER_PW = 'Cashier-pass-1';

/** File-backed database (not :memory:) so restart/persistence behaviour is real. */
export function harness(opts: { now?: Date; dir?: string; seedUsers?: boolean } = {}): Harness {
  const dir = opts.dir ?? tmpDir();
  const file = path.join(dir, 'db', 'srmart.sqlite');
  const db = openDatabase(file);
  const clock = new FixedClock(opts.now ?? new Date(2026, 9, 28, 11, 0, 0)); // 28 Oct 2026 = Kartik 2083
  const ctx = { db, clock };
  const users = new UserRepo(ctx);
  if (opts.seedUsers !== false && !users.byUsername('boss')) {
    users.insert({ username: 'boss', fullName: 'Test Admin', role: 'admin', passwordHash: hashPassword(ADMIN_PW) });
    users.insert({ username: 'till', fullName: 'Test Cashier', role: 'cashier', passwordHash: hashPassword(CASHIER_PW) });
    new SettingsRepo(ctx).setDataMode('live');
  }
  const svc = createServices(ctx);
  const h: Harness = {
    db,
    file,
    dir,
    clock,
    svc,
    admin: toSession(users.byUsername('boss')!),
    cashier: toSession(users.byUsername('till')!),
    reopen() {
      db.close();
      return harness({ now: clock.now(), dir, seedUsers: false });
    },
    close() {
      if (db.open) db.close();
    },
  };
  return h;
}

export function makeProduct(h: Harness, over: Partial<{ name: string; pricePaisa: number; costPaisa: number; openingQty: number; barcode: string | null; minStock: number }> = {}) {
  return h.svc.products.create(h.admin, {
    name: over.name ?? `Test product ${crypto.randomUUID().slice(0, 6)}`,
    categoryId: null,
    unit: 'pcs',
    costPaisa: over.costPaisa ?? 8000,
    pricePaisa: over.pricePaisa ?? 10000,
    minStock: over.minStock ?? 2,
    openingQty: over.openingQty ?? 20,
    barcode: over.barcode ?? null,
  });
}

export function checkout(h: Harness, user: SessionUser, lines: { productId: number; quantity: number; discountPaisa?: number }[], extra: { orderDiscountPaisa?: number; tenderedPaisa?: number; override?: { username: string; password: string } } = {}) {
  const l = lines.map((x) => ({ discountPaisa: 0, ...x }));
  const q = h.svc.sales.quote(user, { lines: l, orderDiscountPaisa: extra.orderDiscountPaisa ?? 0 });
  return h.svc.sales.complete(user, {
    lines: l,
    orderDiscountPaisa: extra.orderDiscountPaisa ?? 0,
    clientTxnId: crypto.randomUUID(),
    expectedTotalPaisa: q.totalPaisa,
    payment: { method: 'cash', tenderedPaisa: extra.tenderedPaisa ?? q.totalPaisa },
    override: extra.override ?? null,
  });
}
