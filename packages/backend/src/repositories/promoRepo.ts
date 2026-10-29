import type { Customer, Page, Promotion, Scheme, SchemeCoupon, SchemeWinner } from '@srmart/shared';
import type { Ctx } from '../context';
import { bool } from '../db/database';

type State = Promotion['state'];
const stateOf = (active: boolean, startsOn: string, endsOn: string, today: string): State =>
  !active ? 'inactive' : today < startsOn ? 'scheduled' : today > endsOn ? 'ended' : 'running';

/** A coupon counts in a draw only while its sale is not voided and not fully returned. */
const ELIGIBLE_SALE = `s.status IN ('completed', 'partially_returned')`;

export interface PromotionFields {
  name: string;
  percentBp: number;
  categoryId: number | null;
  startsOn: string;
  endsOn: string;
  active: boolean;
}

export interface SchemeFields {
  name: string;
  description: string;
  minBillPaisa: number;
  entryStepPaisa: number | null;
  startsOn: string;
  endsOn: string;
  couponPrefix: string;
  active: boolean;
}

export interface ActivePromotion {
  id: number;
  name: string;
  percentBp: number;
  categoryId: number | null;
}

export class PromoRepo {
  constructor(private ctx: Ctx) {}

  private now() {
    return this.ctx.clock.now().toISOString();
  }

  // ---------------- promotions ----------------
  promotions(today: string): Promotion[] {
    const rows = this.ctx.db
      .prepare(
        `SELECT p.*, c.name AS category_name,
           (SELECT COUNT(*) FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE si.promotion_id = p.id AND s.status != 'voided') AS times_applied,
           (SELECT COALESCE(SUM(si.promo_discount_paisa), 0) FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE si.promotion_id = p.id AND s.status != 'voided') AS given
         FROM promotions p LEFT JOIN categories c ON c.id = p.category_id ORDER BY p.starts_on DESC, p.id DESC`,
      )
      .all() as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      name: r.name as string,
      percentBp: r.percent_bp as number,
      categoryId: (r.category_id as number) ?? null,
      categoryName: (r.category_name as string) ?? null,
      startsOn: r.starts_on as string,
      endsOn: r.ends_on as string,
      active: bool(r.active),
      state: stateOf(bool(r.active), r.starts_on as string, r.ends_on as string, today),
      isDemo: bool(r.is_demo),
      timesApplied: r.times_applied as number,
      discountGivenPaisa: r.given as number,
    }));
  }

  /** Promotions in force on a given local date. */
  activePromotions(today: string): ActivePromotion[] {
    return (
      this.ctx.db
        .prepare('SELECT id, name, percent_bp, category_id FROM promotions WHERE active = 1 AND starts_on <= ? AND ends_on >= ?')
        .all(today, today) as { id: number; name: string; percent_bp: number; category_id: number | null }[]
    ).map((r) => ({ id: r.id, name: r.name, percentBp: r.percent_bp, categoryId: r.category_id }));
  }

  insertPromotion(p: PromotionFields, userId: number, isDemo: number): number {
    const now = this.now();
    return Number(
      this.ctx.db
        .prepare('INSERT INTO promotions (name, percent_bp, category_id, starts_on, ends_on, active, is_demo, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(p.name, p.percentBp, p.categoryId, p.startsOn, p.endsOn, p.active ? 1 : 0, isDemo, userId, now, now).lastInsertRowid,
    );
  }

  updatePromotion(id: number, p: PromotionFields) {
    this.ctx.db
      .prepare('UPDATE promotions SET name = ?, percent_bp = ?, category_id = ?, starts_on = ?, ends_on = ?, active = ?, updated_at = ? WHERE id = ?')
      .run(p.name, p.percentBp, p.categoryId, p.startsOn, p.endsOn, p.active ? 1 : 0, this.now(), id);
  }

  // ---------------- customers ----------------
  private mapCustomer(r: Record<string, unknown>): Customer {
    return {
      id: r.id as number,
      name: r.name as string,
      phone: r.phone as string,
      consentAt: (r.consent_at as string) ?? null,
      isDemo: bool(r.is_demo),
      saleCount: (r.sale_count as number) ?? 0,
      totalSpentPaisa: (r.total_spent as number) ?? 0,
      couponCount: (r.coupon_count as number) ?? 0,
      lastPurchaseAt: (r.last_purchase as string) ?? null,
    };
  }

  private static CUSTOMER_SELECT = `SELECT c.*,
    (SELECT COUNT(*) FROM sales s WHERE s.customer_id = c.id AND s.status != 'voided') AS sale_count,
    (SELECT COALESCE(SUM(s.total_paisa), 0) FROM sales s WHERE s.customer_id = c.id AND s.status != 'voided') AS total_spent,
    (SELECT COUNT(*) FROM scheme_entries e WHERE e.customer_id = c.id) AS coupon_count,
    (SELECT MAX(s.created_at) FROM sales s WHERE s.customer_id = c.id) AS last_purchase
    FROM customers c`;

  customerByPhone(phone: string): Customer | null {
    const r = this.ctx.db.prepare(`${PromoRepo.CUSTOMER_SELECT} WHERE c.phone = ?`).get(phone) as Record<string, unknown> | undefined;
    return r ? this.mapCustomer(r) : null;
  }

  customers(f: { q?: string; page: number; pageSize: number }): Page<Customer> {
    const w = f.q ? 'WHERE c.name LIKE ? OR c.phone LIKE ?' : '';
    const params = f.q ? [`%${f.q}%`, `%${f.q}%`] : [];
    const total = (this.ctx.db.prepare(`SELECT COUNT(*) n FROM customers c ${w}`).get(...params) as { n: number }).n;
    const rows = this.ctx.db
      .prepare(`${PromoRepo.CUSTOMER_SELECT} ${w} ORDER BY last_purchase DESC, c.id DESC LIMIT ? OFFSET ?`)
      .all(...params, f.pageSize, (f.page - 1) * f.pageSize) as Record<string, unknown>[];
    return { rows: rows.map((r) => this.mapCustomer(r)), total, page: f.page, pageSize: f.pageSize };
  }

  /** Creates or refreshes a customer by phone, recording when consent was given. */
  upsertCustomer(name: string, phone: string, isDemo: number): number {
    const now = this.now();
    const row = this.ctx.db
      .prepare(
        `INSERT INTO customers (name, phone, consent_at, is_demo, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(phone) DO UPDATE SET name = excluded.name, consent_at = excluded.consent_at, updated_at = excluded.updated_at
         RETURNING id`,
      )
      .get(name, phone, now, isDemo, now, now) as { id: number };
    return row.id;
  }

  // ---------------- schemes ----------------
  private mapScheme(r: Record<string, unknown>, today: string): Scheme {
    return {
      id: r.id as number,
      name: r.name as string,
      description: r.description as string,
      minBillPaisa: r.min_bill_paisa as number,
      entryStepPaisa: (r.entry_step_paisa as number) ?? null,
      startsOn: r.starts_on as string,
      endsOn: r.ends_on as string,
      couponPrefix: r.coupon_prefix as string,
      active: bool(r.active),
      state: stateOf(bool(r.active), r.starts_on as string, r.ends_on as string, today),
      isDemo: bool(r.is_demo),
      couponCount: (r.coupon_count as number) ?? 0,
      eligibleCouponCount: (r.eligible_count as number) ?? 0,
      customerCount: (r.customer_count as number) ?? 0,
      winnerCount: (r.winner_count as number) ?? 0,
    };
  }

  private static SCHEME_SELECT = `SELECT sc.*,
    (SELECT COUNT(*) FROM scheme_entries e WHERE e.scheme_id = sc.id) AS coupon_count,
    (SELECT COUNT(*) FROM scheme_entries e JOIN sales s ON s.id = e.sale_id WHERE e.scheme_id = sc.id AND ${ELIGIBLE_SALE}) AS eligible_count,
    (SELECT COUNT(DISTINCT e.customer_id) FROM scheme_entries e WHERE e.scheme_id = sc.id) AS customer_count,
    (SELECT COUNT(*) FROM scheme_winners w WHERE w.scheme_id = sc.id) AS winner_count
    FROM schemes sc`;

  schemes(today: string): Scheme[] {
    return (this.ctx.db.prepare(`${PromoRepo.SCHEME_SELECT} ORDER BY sc.starts_on DESC, sc.id DESC`).all() as Record<string, unknown>[]).map((r) => this.mapScheme(r, today));
  }

  scheme(id: number, today: string): Scheme | null {
    const r = this.ctx.db.prepare(`${PromoRepo.SCHEME_SELECT} WHERE sc.id = ?`).get(id) as Record<string, unknown> | undefined;
    return r ? this.mapScheme(r, today) : null;
  }

  activeSchemes(today: string): Scheme[] {
    return this.schemes(today).filter((s) => s.state === 'running');
  }

  insertScheme(s: SchemeFields, userId: number, isDemo: number): number {
    const now = this.now();
    return Number(
      this.ctx.db
        .prepare(
          `INSERT INTO schemes (name, description, min_bill_paisa, entry_step_paisa, starts_on, ends_on, coupon_prefix, active, is_demo, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(s.name, s.description, s.minBillPaisa, s.entryStepPaisa, s.startsOn, s.endsOn, s.couponPrefix, s.active ? 1 : 0, isDemo, userId, now, now).lastInsertRowid,
    );
  }

  updateScheme(id: number, s: SchemeFields) {
    this.ctx.db
      .prepare(
        `UPDATE schemes SET name = ?, description = ?, min_bill_paisa = ?, entry_step_paisa = ?, starts_on = ?, ends_on = ?, coupon_prefix = ?, active = ?, updated_at = ? WHERE id = ?`,
      )
      .run(s.name, s.description, s.minBillPaisa, s.entryStepPaisa, s.startsOn, s.endsOn, s.couponPrefix, s.active ? 1 : 0, this.now(), id);
  }

  insertEntry(schemeId: number, saleId: number, customerId: number, couponNo: string, isDemo: number) {
    this.ctx.db
      .prepare('INSERT INTO scheme_entries (scheme_id, sale_id, customer_id, coupon_no, is_demo, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(schemeId, saleId, customerId, couponNo, isDemo, this.now());
  }

  coupons(schemeId: number): SchemeCoupon[] {
    return (
      this.ctx.db
        .prepare(
          `SELECT e.*, s.receipt_no, s.total_paisa, s.status, c.name AS customer_name, c.phone FROM scheme_entries e
           JOIN sales s ON s.id = e.sale_id JOIN customers c ON c.id = e.customer_id WHERE e.scheme_id = ? ORDER BY e.id DESC`,
        )
        .all(schemeId) as Record<string, unknown>[]
    ).map((r) => ({
      id: r.id as number,
      couponNo: r.coupon_no as string,
      saleId: r.sale_id as number,
      receiptNo: r.receipt_no as string,
      billTotalPaisa: r.total_paisa as number,
      customerName: r.customer_name as string,
      customerPhone: r.phone as string,
      createdAt: r.created_at as string,
      eligible: r.status === 'completed' || r.status === 'partially_returned',
    }));
  }

  /** Coupons that may still win: sale not voided/fully returned and coupon not already drawn. */
  eligiblePool(schemeId: number): { id: number; couponNo: string }[] {
    return (
      this.ctx.db
        .prepare(
          `SELECT e.id, e.coupon_no FROM scheme_entries e JOIN sales s ON s.id = e.sale_id
           WHERE e.scheme_id = ? AND ${ELIGIBLE_SALE} AND NOT EXISTS (SELECT 1 FROM scheme_winners w WHERE w.entry_id = e.id)
           ORDER BY e.id`,
        )
        .all(schemeId) as { id: number; coupon_no: string }[]
    ).map((r) => ({ id: r.id, couponNo: r.coupon_no }));
  }

  nextRank(schemeId: number): number {
    return ((this.ctx.db.prepare('SELECT MAX(rank) r FROM scheme_winners WHERE scheme_id = ?').get(schemeId) as { r: number | null }).r ?? 0) + 1;
  }

  insertWinner(schemeId: number, entryId: number, rank: number, prize: string, poolSize: number, userId: number, isDemo: number) {
    this.ctx.db
      .prepare('INSERT INTO scheme_winners (scheme_id, entry_id, rank, prize, pool_size, drawn_by, is_demo, drawn_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(schemeId, entryId, rank, prize, poolSize, userId, isDemo, this.now());
  }

  winners(schemeId: number): SchemeWinner[] {
    return (
      this.ctx.db
        .prepare(
          `SELECT w.*, e.coupon_no, s.receipt_no, c.name AS customer_name, c.phone, u.full_name AS drawn_name
           FROM scheme_winners w JOIN scheme_entries e ON e.id = w.entry_id JOIN sales s ON s.id = e.sale_id
           JOIN customers c ON c.id = e.customer_id JOIN users u ON u.id = w.drawn_by
           WHERE w.scheme_id = ? ORDER BY w.rank`,
        )
        .all(schemeId) as Record<string, unknown>[]
    ).map((r) => ({
      id: r.id as number,
      rank: r.rank as number,
      prize: r.prize as string,
      couponNo: r.coupon_no as string,
      receiptNo: r.receipt_no as string,
      customerName: r.customer_name as string,
      customerPhone: r.phone as string,
      drawnAt: r.drawn_at as string,
      drawnBy: r.drawn_name as string,
      poolSize: r.pool_size as number,
    }));
  }

  /** Coupons attached to a sale (for receipts and sale detail). */
  couponsForSale(saleId: number): { couponNo: string; schemeName: string; eligible: boolean }[] {
    return (
      this.ctx.db
        .prepare(
          `SELECT e.coupon_no, sc.name, s.status FROM scheme_entries e JOIN schemes sc ON sc.id = e.scheme_id JOIN sales s ON s.id = e.sale_id
           WHERE e.sale_id = ? ORDER BY e.id`,
        )
        .all(saleId) as { coupon_no: string; name: string; status: string }[]
    ).map((r) => ({ couponNo: r.coupon_no, schemeName: r.name, eligible: r.status === 'completed' || r.status === 'partially_returned' }));
  }
}
