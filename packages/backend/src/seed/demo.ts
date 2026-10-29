import crypto from 'node:crypto';
import type { SessionUser } from '@srmart/shared';
import { toLocalISODate } from '@srmart/shared';
import { FixedClock } from '../clock';
import type { Ctx } from '../context';
import type { DB } from '../db/database';
import { tx } from '../db/database';
import { SettingsRepo } from '../repositories/settingsRepo';
import { UserRepo } from '../repositories/userRepo';
import { hashPassword, toSession } from '../services/auth';
import { gs1CheckDigit } from '../services/products';
import { createServices } from '../services';

/**
 * Demo credentials for LOCAL DEMONSTRATION ONLY. They are flagged `default_password` and the UI
 * shows a warning until they are changed. Change or disable them before real use.
 */
export const DEMO_USERS = [
  { username: 'admin', password: 'Admin@123', fullName: 'Demo Administrator', role: 'admin' as const },
  { username: 'cashier', password: 'Cashier@123', fullName: 'Demo Cashier', role: 'cashier' as const },
];

/** Fictional EAN-13 using GS1 prefix "20" (restricted in-store circulation) so it can never match a real retail product. */
function demoEan(n: number) {
  const payload = `20${String(n).padStart(10, '0')}`;
  return payload + gs1CheckDigit(payload);
}

interface DemoProduct {
  name: string;
  cat: string;
  brand: string;
  unit: string;
  cost: number; // rupees
  price: number;
  qty: number;
  min: number;
  ean?: boolean;
  expiry?: boolean;
}

// All brand names are fictional and marked "(Demo)".
const PRODUCTS: DemoProduct[] = [
  { name: 'Basmati Rice 5 kg', cat: 'Groceries', brand: 'Himal Harvest (Demo)', unit: 'bag', cost: 820, price: 975, qty: 40, min: 10, ean: true },
  { name: 'Jeera Masino Rice 25 kg', cat: 'Groceries', brand: 'Himal Harvest (Demo)', unit: 'bag', cost: 2350, price: 2650, qty: 12, min: 4, ean: true },
  { name: 'Red Lentils (Masoor Dal) 1 kg', cat: 'Groceries', brand: 'Gaun Ghar (Demo)', unit: 'pkt', cost: 165, price: 195, qty: 60, min: 15, ean: true },
  { name: 'Mustard Oil 1 L', cat: 'Groceries', brand: 'Terai Gold (Demo)', unit: 'btl', cost: 290, price: 340, qty: 36, min: 12, ean: true },
  { name: 'Sunflower Oil 1 L', cat: 'Groceries', brand: 'Terai Gold (Demo)', unit: 'btl', cost: 255, price: 300, qty: 6, min: 10, ean: true },
  { name: 'Sugar 1 kg', cat: 'Groceries', brand: 'Gaun Ghar (Demo)', unit: 'pkt', cost: 105, price: 125, qty: 80, min: 20 },
  { name: 'Iodised Salt 1 kg', cat: 'Groceries', brand: 'Gaun Ghar (Demo)', unit: 'pkt', cost: 22, price: 30, qty: 100, min: 25, ean: true },
  { name: 'Black Tea 500 g', cat: 'Groceries', brand: 'Ilam Hills (Demo)', unit: 'pkt', cost: 330, price: 395, qty: 24, min: 8, ean: true },
  { name: 'Chiura (Beaten Rice) 1 kg', cat: 'Groceries', brand: 'Local loose stock', unit: 'pkt', cost: 95, price: 120, qty: 3, min: 10 },
  { name: 'Instant Noodles Chicken 70 g', cat: 'Packaged Foods', brand: 'Chau Chau Co. (Demo)', unit: 'pkt', cost: 20, price: 25, qty: 240, min: 60, ean: true },
  { name: 'Instant Noodles Veg 70 g', cat: 'Packaged Foods', brand: 'Chau Chau Co. (Demo)', unit: 'pkt', cost: 20, price: 25, qty: 180, min: 60, ean: true },
  { name: 'Glucose Biscuits 120 g', cat: 'Packaged Foods', brand: 'Bakery Bazaar (Demo)', unit: 'pkt', cost: 32, price: 40, qty: 90, min: 30, ean: true, expiry: true },
  { name: 'Cream Biscuits Chocolate 150 g', cat: 'Packaged Foods', brand: 'Bakery Bazaar (Demo)', unit: 'pkt', cost: 48, price: 60, qty: 8, min: 20, ean: true, expiry: true },
  { name: 'Potato Chips Masala 50 g', cat: 'Packaged Foods', brand: 'Crunchy Hills (Demo)', unit: 'pkt', cost: 40, price: 50, qty: 70, min: 25, ean: true },
  { name: 'Mango Juice 1 L', cat: 'Packaged Foods', brand: 'Fresh Valley (Demo)', unit: 'pack', cost: 150, price: 185, qty: 30, min: 10, ean: true, expiry: true },
  { name: 'Mineral Water 1 L', cat: 'Packaged Foods', brand: 'Himal Spring (Demo)', unit: 'btl', cost: 22, price: 30, qty: 150, min: 48, ean: true },
  { name: 'Cola Soft Drink 500 ml', cat: 'Packaged Foods', brand: 'Fizzy Peak (Demo)', unit: 'btl', cost: 60, price: 75, qty: 64, min: 24, ean: true },
  { name: 'Peanut Butter 340 g', cat: 'Packaged Foods', brand: 'Nutty Nepal (Demo)', unit: 'jar', cost: 360, price: 450, qty: 2, min: 5, ean: true, expiry: true },
  { name: 'Herbal Shampoo 180 ml', cat: 'Cosmetics', brand: 'Saathi Care (Demo)', unit: 'btl', cost: 210, price: 265, qty: 28, min: 8, ean: true },
  { name: 'Anti-dandruff Shampoo 340 ml', cat: 'Cosmetics', brand: 'Saathi Care (Demo)', unit: 'btl', cost: 395, price: 480, qty: 14, min: 6, ean: true },
  { name: 'Neem Soap 100 g', cat: 'Cosmetics', brand: 'Saathi Care (Demo)', unit: 'pcs', cost: 45, price: 60, qty: 120, min: 30, ean: true },
  { name: 'Moisturising Cream 100 ml', cat: 'Cosmetics', brand: 'Glow Lotus (Demo)', unit: 'tube', cost: 240, price: 310, qty: 18, min: 6, ean: true, expiry: true },
  { name: 'Lip Balm Strawberry', cat: 'Cosmetics', brand: 'Glow Lotus (Demo)', unit: 'pcs', cost: 95, price: 135, qty: 4, min: 8, ean: true },
  { name: 'Toothpaste Herbal 150 g', cat: 'Cosmetics', brand: 'Smile Himal (Demo)', unit: 'tube', cost: 120, price: 150, qty: 55, min: 15, ean: true },
  { name: 'Kajal Black', cat: 'Cosmetics', brand: 'Glow Lotus (Demo)', unit: 'pcs', cost: 110, price: 160, qty: 22, min: 6 },
  { name: 'Cotton T-Shirt Round Neck — M', cat: 'Clothing', brand: 'SR Basics (Demo)', unit: 'pcs', cost: 420, price: 650, qty: 15, min: 5 },
  { name: 'Cotton T-Shirt Round Neck — L', cat: 'Clothing', brand: 'SR Basics (Demo)', unit: 'pcs', cost: 420, price: 650, qty: 12, min: 5 },
  { name: 'Denim Jeans Slim — 32', cat: 'Clothing', brand: 'SR Basics (Demo)', unit: 'pcs', cost: 1250, price: 1850, qty: 8, min: 3 },
  { name: 'Kids Hoodie — 6-8 yrs', cat: 'Clothing', brand: 'Little Yeti (Demo)', unit: 'pcs', cost: 780, price: 1150, qty: 2, min: 3 },
  { name: 'Cotton Socks (3 pairs)', cat: 'Clothing', brand: 'SR Basics (Demo)', unit: 'set', cost: 180, price: 290, qty: 30, min: 10 },
  { name: 'Woollen Cap', cat: 'Clothing', brand: 'Little Yeti (Demo)', unit: 'pcs', cost: 220, price: 350, qty: 20, min: 6 },
  { name: 'Dish Wash Bar 200 g', cat: 'Household', brand: 'Sparkle Home (Demo)', unit: 'pcs', cost: 32, price: 45, qty: 90, min: 30, ean: true },
  { name: 'Detergent Powder 1 kg', cat: 'Household', brand: 'Sparkle Home (Demo)', unit: 'pkt', cost: 175, price: 220, qty: 40, min: 12, ean: true },
  { name: 'Floor Cleaner 1 L', cat: 'Household', brand: 'Sparkle Home (Demo)', unit: 'btl', cost: 185, price: 240, qty: 16, min: 6, ean: true },
  { name: 'Toilet Tissue (4 rolls)', cat: 'Household', brand: 'Softy (Demo)', unit: 'pack', cost: 160, price: 210, qty: 26, min: 10, ean: true },
  { name: 'LED Bulb 9 W', cat: 'Household', brand: 'Ujyalo (Demo)', unit: 'pcs', cost: 120, price: 175, qty: 35, min: 10 },
  { name: 'Plastic Bucket 15 L', cat: 'Household', brand: 'Ghar Ghar (Demo)', unit: 'pcs', cost: 260, price: 375, qty: 9, min: 4 },
  { name: 'Steel Water Bottle 1 L', cat: 'Household', brand: 'Ghar Ghar (Demo)', unit: 'pcs', cost: 480, price: 690, qty: 11, min: 4 },
  { name: 'Mosquito Coil (10 pcs)', cat: 'Household', brand: 'Sukha Nidra (Demo)', unit: 'box', cost: 55, price: 75, qty: 5, min: 15, ean: true },
  { name: 'Matchbox (10 pack)', cat: 'Household', brand: 'Agni (Demo)', unit: 'pack', cost: 18, price: 25, qty: 80, min: 20 },
];

const SUPPLIERS = [
  { name: 'Demo Supplier — Himalaya Wholesale (fictional)', contactName: 'Demo Contact A', phone: '000-0000001' },
  { name: 'Demo Supplier — Valley Cosmetics Trading (fictional)', contactName: 'Demo Contact B', phone: '000-0000002' },
  { name: 'Demo Supplier — Everest Garments (fictional)', contactName: 'Demo Contact C', phone: '000-0000003' },
];

/** Small deterministic PRNG so demo data is the same on every reset. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Creates the demo login accounts if the database has no users yet. */
export function ensureDemoUsers(db: DB, clock = new FixedClock(new Date())) {
  const ctx: Ctx = { db, clock };
  const users = new UserRepo(ctx);
  if (users.list().length) return;
  tx(db, () => {
    for (const u of DEMO_USERS) {
      users.insert({ username: u.username, fullName: u.fullName, role: u.role, passwordHash: hashPassword(u.password), isDemo: true, defaultPassword: true });
    }
  });
}

/**
 * Seeds fictional demo data through the real services (so stock ledger, receipt numbers and
 * fiscal-year tagging are exactly what a live sale would produce). Everything is flagged is_demo.
 */
export function seedDemoData(db: DB, now = new Date()) {
  ensureDemoUsers(db);
  const clock = new FixedClock(now);
  const ctx: Ctx = { db, clock };
  const settings = new SettingsRepo(ctx);
  settings.setDataMode('demo');
  if (!settings.getRaw('settings')) {
    const s = settings.getSettings();
    s.store.address = 'Demo address — set real store details in Settings';
    s.paymentMethods = s.paymentMethods.map((m) => (m.code === 'qr' ? { ...m, enabled: true } : m));
    settings.saveSettings(s);
  }
  const svc = createServices(ctx);
  const userRepo = new UserRepo(ctx);
  const admin: SessionUser = toSession(userRepo.byUsername('admin') ?? userRepo.list().find((u) => u.role === 'admin')!);
  const cashierRec = userRepo.byUsername('cashier') ?? userRepo.list().find((u) => u.role === 'cashier');
  const cashier: SessionUser = cashierRec ? toSession(cashierRec) : admin;

  const day = (offset: number, hour: number, minute = 0) => {
    const d = new Date(now);
    d.setDate(d.getDate() + offset);
    d.setHours(hour, minute, 0, 0);
    return d;
  };

  // Products are created 40 days ago with opening stock.
  clock.set(day(-140, 9));
  const cats = new Map<string, number>();
  for (const name of ['Groceries', 'Packaged Foods', 'Cosmetics', 'Clothing', 'Household']) {
    cats.set(name, svc.products.createCategory(admin, name).id);
  }
  const products = PRODUCTS.map((p, i) =>
    svc.products.create(admin, {
      name: p.name,
      categoryId: cats.get(p.cat)!,
      brand: p.brand,
      unit: p.unit,
      costPaisa: p.cost * 100,
      pricePaisa: p.price * 100,
      minStock: p.min,
      trackExpiry: !!p.expiry,
      openingQty: p.qty + 60,
      barcode: p.ean ? demoEan(1000 + i) : null,
      generateInternalBarcode: !p.ean,
    }),
  );

  const suppliers = SUPPLIERS.map((s) => svc.purchases.createSupplier(admin, { ...s, email: null, address: 'Fictional demo address', panVat: null, notes: 'Fictional supplier for demonstration' }));

  // Purchases: one per supplier, ~25 days ago, including batches with expiry dates.
  clock.set(day(-25, 10));
  const groups: [number, (p: DemoProduct) => boolean][] = [
    [0, (p) => p.cat === 'Groceries' || p.cat === 'Packaged Foods' || p.cat === 'Household'],
    [1, (p) => p.cat === 'Cosmetics'],
    [2, (p) => p.cat === 'Clothing'],
  ];
  groups.forEach(([si, pick], gi) => {
    const items = products
      .map((prod, i) => ({ prod, def: PRODUCTS[i]! }))
      .filter((x) => pick(x.def))
      .slice(0, 6)
      .map(({ prod, def }) => ({
        productId: prod.id,
        quantity: 12,
        unitCostPaisa: prod.costPaisa,
        batchNo: def.expiry ? `DEMO-B${gi}${prod.id}` : null,
        expiryDate: def.expiry ? toLocalISODate(day(def.name.includes('Peanut') ? 12 : 120, 12)) : null,
      }));
    svc.purchases.receive(admin, { supplierId: suppliers[si]!.id, invoiceNo: `DEMO-INV-${1001 + gi}`, invoiceDate: toLocalISODate(day(-25, 10)), notes: 'Demo purchase', items, updateCostPrice: false });
  });

  // Sales: a handful in the previous fiscal year (to demonstrate FY separation) + the last 21 days.
  // Festival discount and lucky-draw scheme (fictional, clearly marked Demo).
  clock.set(day(-16, 8));
  svc.promotions.createPromotion(admin, { name: 'Tihar offer (Demo)', percentBp: 1000, categoryId: cats.get('Clothing')!, startsOn: toLocalISODate(day(-12, 12)), endsOn: toLocalISODate(day(10, 12)) });
  svc.promotions.createScheme(admin, {
    name: 'Tihar Lucky Draw (Demo)',
    description: 'Demo scheme: one coupon for bills of Rs 2,000 or more, plus one coupon per extra Rs 1,000.',
    minBillPaisa: 200000,
    entryStepPaisa: 100000,
    startsOn: toLocalISODate(day(-14, 12)),
    endsOn: toLocalISODate(day(14, 12)),
    couponPrefix: 'TIHAR',
  });
  const demoCustomers = ['Demo Customer A', 'Demo Customer B', 'Demo Customer C', 'Demo Customer D'];
  const bigBasket = ['Jeera Masino Rice 25 kg', 'Denim Jeans Slim — 32', 'Steel Water Bottle 1 L'].map((n) => products[PRODUCTS.findIndex((x) => x.name === n)]!);
  let custIdx = 0;

  const rand = rng(20831);
  const sell = (when: Date, who: SessionUser, big = false) => {
    clock.set(when);
    const n = 1 + Math.floor(rand() * 4);
    const lines = new Map<number, number>();
    if (big) for (const p of bigBasket) lines.set(p.id, 1);
    else
      for (let k = 0; k < n; k++) {
        const p = products[Math.floor(rand() * products.length)]!;
        lines.set(p.id, (lines.get(p.id) ?? 0) + 1 + Math.floor(rand() * 2));
      }
    const cart = [...lines].map(([productId, quantity]) => ({ productId, quantity, discountPaisa: 0 }));
    const fresh = svc.products.repo.byIds(cart.map((c) => c.productId));
    const ok = cart.filter((c) => (fresh.find((f) => f.id === c.productId)?.qtyOnHand ?? 0) >= c.quantity);
    if (!ok.length) return null;
    const orderDiscountPaisa = who.role === 'admin' && rand() < 0.2 ? 1000 : 0;
    const q = svc.sales.quote(who, { lines: ok, orderDiscountPaisa });
    const tendered = Math.ceil(q.totalPaisa / 50000) * 50000;
    return svc.sales.complete(who, {
      lines: ok,
      orderDiscountPaisa,
      clientTxnId: crypto.randomUUID(),
      expectedTotalPaisa: q.totalPaisa,
      // Fictional customers with placeholder numbers (0100…) that cannot be real Nepali mobiles.
      customer: big && q.qualifyingSchemes.length ? { name: demoCustomers[custIdx % 4]!, phone: `010000000${(custIdx++ % 4) + 1}`, consent: true as const } : null,
      payment: rand() < 0.15 ? { method: 'qr', tenderedPaisa: q.totalPaisa, reference: `DEMO-QR-${Math.floor(rand() * 99999)}` } : { method: 'cash', tenderedPaisa: tendered },
    });
  };

  // Previous fiscal year: ~4 months back lands before 1 Shrawan when seeded in Kartik.
  for (let d = -125; d <= -110; d += 3) sell(day(d, 14), admin);

  let lastSale = null as ReturnType<typeof sell>;
  for (let d = -20; d <= 0; d++) {
    const count = d === 0 ? 5 : 6 + Math.floor(rand() * 8);
    for (let k = 0; k < count; k++) {
      const when = day(d, 9 + Math.floor((k / count) * 10), Math.floor(rand() * 59));
      if (d === 0 && when > now) continue;
      const s = sell(when, rand() < 0.7 ? cashier : admin);
      if (s) lastSale = s;
    }
    if (d >= -13 && d % 2 === 0 && day(d, 18, 30) <= now) sell(day(d, 18, 30), admin, true);
    if (d === -6 && lastSale) {
      clock.set(day(d, 19));
      svc.sales.void(admin, { saleId: lastSale.id, reason: 'Demo: customer cancelled before leaving counter' });
    }
    if (d === -3 && lastSale) {
      clock.set(day(d, 19, 30));
      const item = lastSale.items[0]!;
      svc.sales.createReturn(admin, { saleId: lastSale.id, items: [{ saleItemId: item.id, quantity: 1 }], reason: 'Demo: damaged packaging returned', restock: false });
    }
  }

  // A price change after labels were printed, to demonstrate the "labels outdated" warning.
  clock.set(day(-2, 9));
  const tea = products.find((p) => p.name.startsWith('Black Tea'))!;
  svc.products.repo.markLabelsPrinted([tea.id]);
  clock.set(day(-1, 9));
  const fresh = svc.products.repo.byId(tea.id)!;
  svc.products.update(admin, { id: tea.id, name: fresh.name, categoryId: fresh.categoryId, brand: fresh.brand, unit: fresh.unit, costPaisa: fresh.costPaisa, pricePaisa: 41500, minStock: fresh.minStock, trackExpiry: fresh.trackExpiry, priceChangeReason: 'Demo: supplier price increase' });

  // Bring opening stock back near the intended demo levels (some low-stock items for alerts).
  clock.set(day(0, 8));
  for (const [i, p] of products.entries()) {
    const cur = svc.products.repo.byId(p.id)!;
    const target = PRODUCTS[i]!.qty;
    if (cur.qtyOnHand !== target) {
      svc.inventory.adjust(admin, { productId: p.id, quantityDelta: target - cur.qtyOnHand, reason: 'count_correction', note: 'Demo data: set demo stock level' });
    }
  }
  return { products: products.length, suppliers: suppliers.length };
}
