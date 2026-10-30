import type { SavedCart, SessionUser } from '@srmart/shared';
import { cartActionSchema, cartSaveSchema, parkCartSchema } from '@srmart/shared';
import type { Ctx } from '../context';
import { tx } from '../db/database';
import { conflict, forbidden, invalid, notFound } from '../errors';
import { ProductRepo } from '../repositories/productRepo';
import { AuditRepo } from '../repositories/auditRepo';

type Row = { id: string; user_id: number; state: string; name: string; payload: string; revision: number; updated_at: string };
export class CartService {
  constructor(private ctx: Ctx) {}
  private row(id: string) { return this.ctx.db.prepare('SELECT * FROM checkout_carts WHERE id = ?').get(id) as Row | undefined; }
  private own(user: SessionUser, id: string): Row {
    const row = this.row(id);
    if (!row) throw notFound('Cart');
    if (row.user_id !== user.id) throw forbidden('This cart belongs to another cashier');
    return row;
  }
  private view(row: Row): SavedCart {
    const payload = JSON.parse(row.payload) as { lines: { productId: number; quantity: number; discountPaisa: number }[]; orderDiscountPaisa: number };
    const products = new Map(new ProductRepo(this.ctx).byIds(payload.lines.map((l) => l.productId)).map((p) => [p.id, p]));
    return { id: row.id, name: row.name, state: row.state as SavedCart['state'], revision: row.revision, updatedAt: row.updated_at,
      orderDiscountPaisa: payload.orderDiscountPaisa, lines: payload.lines.map((l) => {
        const p = products.get(l.productId);
        return { ...l, name: p?.name ?? `Unavailable product #${l.productId}`, sku: p?.sku ?? '', unit: p?.unit ?? 'pcs', unitPricePaisa: p?.pricePaisa ?? 0, qtyAvailable: p?.qtyOnHand ?? 0 };
      }) };
  }
  current(user: SessionUser) {
    const row = this.ctx.db.prepare("SELECT * FROM checkout_carts WHERE user_id = ? AND state = 'current'").get(user.id) as Row | undefined;
    return row ? this.view(row) : null;
  }
  list(user: SessionUser): SavedCart[] {
    return (this.ctx.db.prepare("SELECT * FROM checkout_carts WHERE user_id = ? AND state = 'parked' ORDER BY updated_at DESC").all(user.id) as Row[]).map((r) => this.view(r));
  }
  save(user: SessionUser, input: unknown): SavedCart {
    const p = cartSaveSchema.parse(input);
    return tx(this.ctx.db, () => {
      const existing = this.row(p.id);
      const payload = JSON.stringify({ lines: p.lines, orderDiscountPaisa: p.orderDiscountPaisa });
      const now = this.ctx.clock.now().toISOString();
      if (existing) {
        this.own(user, p.id);
        if (existing.state !== 'current') throw conflict('This cart is no longer active. Reload checkout.');
        // A retry after a lost response is safe, but never revive completed/discarded carts.
        if (existing.payload === payload) return this.view(existing);
        if (existing.revision !== p.revision) throw conflict('This cart changed elsewhere. Reload checkout.');
        this.ctx.db.prepare('UPDATE checkout_carts SET payload = ?, revision = revision + 1, updated_at = ? WHERE id = ?').run(payload, now, p.id);
      } else {
        if (p.revision !== 0) throw conflict('Cart no longer exists');
        if (this.ctx.db.prepare('SELECT id FROM sales WHERE client_txn_id = ?').get(p.id)) throw conflict('This checkout already completed');
        if (this.current(user)) throw conflict('An active cart already exists. Resume it first.');
        this.ctx.db.prepare("INSERT INTO checkout_carts (id, user_id, state, payload, created_at, updated_at) VALUES (?, ?, 'current', ?, ?, ?)").run(p.id, user.id, payload, now, now);
      }
      return this.view(this.row(p.id)!);
    });
  }
  park(user: SessionUser, input: unknown) {
    const p = parkCartSchema.parse(input);
    return tx(this.ctx.db, () => {
      const row = this.own(user, p.id);
      if (row.state === 'parked' && row.revision === p.revision + 1 && row.name === p.name) return this.view(row);
      if (row.state !== 'current' || row.revision !== p.revision) throw conflict('Cart changed. Refresh before parking.');
      if (!this.view(row).lines.length) throw invalid('Cannot park an empty cart');
      if (this.list(user).length >= 100) throw invalid('Remove old parked carts before adding more (limit 100)');
      this.ctx.db.prepare("UPDATE checkout_carts SET state = 'parked', name = ?, revision = revision + 1, updated_at = ? WHERE id = ?").run(p.name, this.ctx.clock.now().toISOString(), p.id);
      new AuditRepo(this.ctx).log({ action: 'cart.parked', entityType: 'cart', entityId: p.id, userId: user.id, details: { name: p.name } });
      return this.view(this.row(p.id)!);
    });
  }
  resume(user: SessionUser, input: unknown) {
    const p = cartActionSchema.parse(input);
    return tx(this.ctx.db, () => {
      const row = this.own(user, p.id);
      if (row.state === 'current' && row.revision === p.revision + 1) return this.view(row);
      if (row.state !== 'parked' || row.revision !== p.revision) throw conflict('Cart changed. Refresh before resuming.');
      const current = this.current(user);
      if (current?.lines.length) throw conflict('Park or clear the current sale before resuming another cart');
      if (current) this.ctx.db.prepare("UPDATE checkout_carts SET state = 'discarded', revision = revision + 1 WHERE id = ?").run(current.id);
      this.ctx.db.prepare("UPDATE checkout_carts SET state = 'current', revision = revision + 1, updated_at = ? WHERE id = ?").run(this.ctx.clock.now().toISOString(), p.id);
      new AuditRepo(this.ctx).log({ action: 'cart.resumed', entityType: 'cart', entityId: p.id, userId: user.id });
      return this.view(this.row(p.id)!);
    });
  }
  discard(user: SessionUser, input: unknown): { ok: true } {
    const p = cartActionSchema.parse(input);
    return tx(this.ctx.db, () => {
      const row = this.own(user, p.id);
      if (row.state === 'discarded') return { ok: true };
      if (row.state === 'completed' || row.revision !== p.revision) throw conflict('Cart changed. Refresh before clearing.');
      this.ctx.db.prepare("UPDATE checkout_carts SET state = 'discarded', revision = revision + 1, updated_at = ? WHERE id = ?").run(this.ctx.clock.now().toISOString(), p.id);
      new AuditRepo(this.ctx).log({ action: 'cart.discarded', entityType: 'cart', entityId: p.id, userId: user.id });
      return { ok: true };
    });
  }
  /** Called inside the sale transaction so delayed autosaves cannot resurrect a paid cart. */
  complete(user: SessionUser, id: string) {
    const row = this.row(id);
    if (!row) return;
    this.own(user, id);
    if (row.state !== 'current') throw conflict('Resume this cart before completing checkout');
    this.ctx.db.prepare("UPDATE checkout_carts SET state = 'completed', revision = revision + 1, updated_at = ? WHERE id = ?").run(this.ctx.clock.now().toISOString(), id);
  }
}
