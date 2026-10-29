import crypto from 'node:crypto';
import type { SchemeDetail, SchemeWinner, SessionUser } from '@srmart/shared';
import { drawSchema, phoneSchema, promotionInputSchema, schemeInputSchema } from '@srmart/shared';
import type { Ctx } from '../context';
import { businessDate } from '../clock';
import { tx } from '../db/database';
import { conflict, invalid, notFound } from '../errors';
import { AuditRepo } from '../repositories/auditRepo';
import { PromoRepo, type ActivePromotion } from '../repositories/promoRepo';
import { SequenceRepo } from '../repositories/sequenceRepo';
import { SettingsRepo } from '../repositories/settingsRepo';
import { requireRole } from './auth';

const MAX_COUPONS_PER_BILL = 100;

/** Coupons a bill earns: 1 at the minimum, plus 1 per extra step (if a step is set). */
export function couponsFor(totalPaisa: number, minBillPaisa: number, stepPaisa: number | null): number {
  if (totalPaisa < minBillPaisa) return 0;
  if (!stepPaisa) return 1;
  return Math.min(MAX_COUPONS_PER_BILL, 1 + Math.floor((totalPaisa - minBillPaisa) / stepPaisa));
}

/** Best (highest %) active promotion for a product: category-specific or store-wide. */
export function bestPromotion(promos: ActivePromotion[], categoryId: number | null): ActivePromotion | null {
  let best: ActivePromotion | null = null;
  for (const p of promos) {
    if (p.categoryId !== null && p.categoryId !== categoryId) continue;
    if (!best || p.percentBp > best.percentBp) best = p;
  }
  return best;
}

/**
 * Festival discounts (automatic % off) and lucky-draw schemes (coupons for bills above a threshold).
 * Customer contact details are stored only with consent, and coupons are created inside the sale
 * transaction so a sale and its coupons are always saved together.
 */
export class PromotionService {
  readonly repo: PromoRepo;
  private audit: AuditRepo;
  private seq: SequenceRepo;
  private settings: SettingsRepo;

  constructor(private ctx: Ctx) {
    this.repo = new PromoRepo(ctx);
    this.audit = new AuditRepo(ctx);
    this.seq = new SequenceRepo(ctx);
    this.settings = new SettingsRepo(ctx);
  }

  private today() {
    return businessDate(this.ctx.clock);
  }

  // ---------------- promotions ----------------
  listPromotions() {
    return this.repo.promotions(this.today());
  }

  createPromotion(user: SessionUser, input: unknown) {
    requireRole(user, 'admin');
    const p = promotionInputSchema.parse(input);
    const id = tx(this.ctx.db, () => {
      const newId = this.repo.insertPromotion(p, user.id, this.settings.isDemo());
      this.audit.log({ action: 'promotion.created', entityType: 'promotion', entityId: newId, userId: user.id, details: { ...p } });
      return newId;
    });
    return this.repo.promotions(this.today()).find((x) => x.id === id)!;
  }

  updatePromotion(user: SessionUser, input: unknown) {
    requireRole(user, 'admin');
    const id = Number((input as { id?: unknown })?.id);
    const p = promotionInputSchema.parse(input);
    tx(this.ctx.db, () => {
      const before = this.repo.promotions(this.today()).find((x) => x.id === id);
      if (!before) throw notFound('Promotion');
      this.repo.updatePromotion(id, p);
      this.audit.log({ action: 'promotion.updated', entityType: 'promotion', entityId: id, userId: user.id, details: { before: { percentBp: before.percentBp, startsOn: before.startsOn, endsOn: before.endsOn, active: before.active }, after: { ...p } } });
    });
    return this.repo.promotions(this.today()).find((x) => x.id === id)!;
  }

  // ---------------- schemes ----------------
  listSchemes() {
    return this.repo.schemes(this.today());
  }

  getScheme(id: number): SchemeDetail {
    const s = this.repo.scheme(id, this.today());
    if (!s) throw notFound('Scheme');
    return { ...s, coupons: this.repo.coupons(id), winners: this.repo.winners(id) };
  }

  private assertPrefixFree(prefix: string, exceptId?: number) {
    const clash = this.repo.schemes(this.today()).find((s) => s.couponPrefix === prefix && s.id !== exceptId);
    if (clash) throw conflict(`Coupon prefix ${prefix} is already used by "${clash.name}"`);
  }

  createScheme(user: SessionUser, input: unknown) {
    requireRole(user, 'admin');
    const s = schemeInputSchema.parse(input);
    const id = tx(this.ctx.db, () => {
      this.assertPrefixFree(s.couponPrefix);
      const newId = this.repo.insertScheme(s, user.id, this.settings.isDemo());
      this.audit.log({ action: 'scheme.created', entityType: 'scheme', entityId: newId, userId: user.id, details: { ...s } });
      return newId;
    });
    return this.repo.scheme(id, this.today())!;
  }

  updateScheme(user: SessionUser, input: unknown) {
    requireRole(user, 'admin');
    const id = Number((input as { id?: unknown })?.id);
    const s = schemeInputSchema.parse(input);
    tx(this.ctx.db, () => {
      const before = this.repo.scheme(id, this.today());
      if (!before) throw notFound('Scheme');
      this.assertPrefixFree(s.couponPrefix, id);
      if (before.couponCount > 0 && (before.couponPrefix !== s.couponPrefix || before.minBillPaisa !== s.minBillPaisa || before.entryStepPaisa !== s.entryStepPaisa)) {
        throw invalid('Coupons were already issued: the prefix, minimum bill and coupon step can no longer change. End this scheme and create a new one instead.');
      }
      this.repo.updateScheme(id, s);
      this.audit.log({ action: 'scheme.updated', entityType: 'scheme', entityId: id, userId: user.id, details: { ...s } });
    });
    return this.repo.scheme(id, this.today())!;
  }

  /** Schemes running today with the coupons a bill of this total would earn (and how far off the rest are). */
  evaluate(totalPaisa: number) {
    const running = this.repo.activeSchemes(this.today());
    return {
      qualifying: running
        .map((s) => ({ id: s.id, name: s.name, minBillPaisa: s.minBillPaisa, coupons: couponsFor(totalPaisa, s.minBillPaisa, s.entryStepPaisa) }))
        .filter((s) => s.coupons > 0),
      near: running.filter((s) => totalPaisa < s.minBillPaisa).map((s) => ({ id: s.id, name: s.name, minBillPaisa: s.minBillPaisa, shortByPaisa: s.minBillPaisa - totalPaisa })),
    };
  }

  /** Called inside the sale transaction (after the customer row exists). Returns the coupon numbers issued. */
  issueForSale(saleId: number, totalPaisa: number, customerId: number, isDemo: number) {
    if (!this.ctx.db.inTransaction) throw new Error('Coupons must be issued inside the sale transaction');
    const issued: string[] = [];
    for (const s of this.repo.activeSchemes(this.today())) {
      const n = couponsFor(totalPaisa, s.minBillPaisa, s.entryStepPaisa);
      for (let i = 0; i < n; i++) {
        const couponNo = `${s.couponPrefix}-${String(this.seq.next(`COUPON:${s.id}`)).padStart(5, '0')}`;
        this.repo.insertEntry(s.id, saleId, customerId, couponNo, isDemo);
        issued.push(couponNo);
      }
    }
    return issued;
  }

  /**
   * Draws winners uniformly at random (crypto.randomInt) from eligible coupons: sale not voided or
   * fully returned, coupon not already a winner. Every coupon has an equal chance; a customer with
   * more coupons has proportionally more chances. Results are permanent and audit-logged.
   */
  draw(user: SessionUser, input: unknown): SchemeWinner[] {
    requireRole(user, 'admin');
    const d = drawSchema.parse(input);
    return tx(this.ctx.db, () => {
      const scheme = this.repo.scheme(d.schemeId, this.today());
      if (!scheme) throw notFound('Scheme');
      if (scheme.state !== 'ended' && !d.allowBeforeEnd) {
        throw invalid(`"${scheme.name}" runs until ${scheme.endsOn}. Draw after it ends, or confirm drawing early.`);
      }
      const pool = this.repo.eligiblePool(d.schemeId);
      if (pool.length < d.count) throw invalid(`Only ${pool.length} eligible coupon(s) left; cannot draw ${d.count}.`);
      const poolSize = pool.length;
      let rank = this.repo.nextRank(d.schemeId);
      const picked: string[] = [];
      for (let i = 0; i < d.count; i++) {
        const idx = crypto.randomInt(pool.length);
        const [entry] = pool.splice(idx, 1);
        this.repo.insertWinner(d.schemeId, entry!.id, rank++, d.prize, poolSize, user.id, scheme.isDemo ? 1 : 0);
        picked.push(entry!.couponNo);
      }
      this.audit.log({ action: 'scheme.draw', entityType: 'scheme', entityId: d.schemeId, userId: user.id, details: { prize: d.prize, count: d.count, poolSize, winners: picked, early: scheme.state !== 'ended' } });
      return this.repo.winners(d.schemeId).slice(-d.count);
    });
  }

  // ---------------- customers ----------------
  customers(user: SessionUser, input: { q?: string; page?: number; pageSize?: number } = {}) {
    requireRole(user, 'admin');
    return this.repo.customers({ q: input.q ? String(input.q).slice(0, 50) : undefined, page: Math.max(1, Number(input.page ?? 1)), pageSize: Math.min(200, Math.max(5, Number(input.pageSize ?? 25))) });
  }

  /** Returning-customer lookup at the counter (fills the name when the phone is known). */
  lookupCustomer(phone: string) {
    const parsed = phoneSchema.safeParse(phone);
    return parsed.success ? this.repo.customerByPhone(parsed.data) : null;
  }
}
