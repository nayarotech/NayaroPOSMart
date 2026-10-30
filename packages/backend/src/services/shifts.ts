import type { CashShift, SessionUser } from '@srmart/shared';
import { cashMovementSchema, closeShiftSchema, openShiftSchema } from '@srmart/shared';
import type { Ctx } from '../context';
import { tx } from '../db/database';
import { conflict, forbidden, invalid, notFound } from '../errors';
import { AuditRepo } from '../repositories/auditRepo';
import { SettingsRepo } from '../repositories/settingsRepo';

export class ShiftService {
  constructor(private ctx: Ctx) {}

  current(): CashShift | null {
    const row = this.ctx.db.prepare('SELECT id FROM cash_shifts WHERE closed_at IS NULL').get() as { id: number } | undefined;
    return row ? this.detail(row.id) : null;
  }

  private detail(id: number): CashShift {
    const row = this.ctx.db.prepare(`SELECT s.*, u.full_name opened_name, c.full_name closed_name
      FROM cash_shifts s JOIN users u ON u.id = s.opened_by LEFT JOIN users c ON c.id = s.closed_by WHERE s.id = ?`).get(id) as {
        id: number; opened_by: number; opened_name: string; opened_at: string; opening_paisa: number;
        closed_name: string | null; closed_at: string | null; counted_paisa: number | null; expected_paisa: number | null; closing_note: string | null;
      } | undefined;
    if (!row) throw notFound('Shift');
    const payments = this.ctx.db.prepare(`SELECT method,
      SUM(CASE WHEN kind = 'payment' THEN amount_paisa ELSE 0 END) receivedPaisa,
      SUM(CASE WHEN kind = 'refund' THEN amount_paisa ELSE 0 END) refundedPaisa
      FROM payments WHERE shift_id = ? GROUP BY method ORDER BY method`).all(id) as CashShift['payments'];
    const movements = this.ctx.db.prepare(`SELECT m.id, m.kind, m.amount_paisa amountPaisa, m.reason,
      u.full_name userName, m.created_at createdAt FROM cash_movements m JOIN users u ON u.id = m.created_by
      WHERE shift_id = ? ORDER BY m.id`).all(id) as CashShift['movements'];
    const cashInPaisa = movements.filter((m) => m.kind === 'in').reduce((n, m) => n + m.amountPaisa, 0);
    const cashOutPaisa = movements.filter((m) => m.kind === 'out').reduce((n, m) => n + m.amountPaisa, 0);
    const cash = payments.find((p) => p.method === 'cash');
    const expectedPaisa = row.expected_paisa ?? row.opening_paisa + (cash?.receivedPaisa ?? 0) - (cash?.refundedPaisa ?? 0) + cashInPaisa - cashOutPaisa;
    return {
      id: row.id, openedBy: row.opened_by, openedByName: row.opened_name, openedAt: row.opened_at,
      openingPaisa: row.opening_paisa, closedByName: row.closed_name, closedAt: row.closed_at,
      countedPaisa: row.counted_paisa, expectedPaisa, variancePaisa: row.counted_paisa === null ? null : row.counted_paisa - expectedPaisa,
      closingNote: row.closing_note, payments, cashInPaisa, cashOutPaisa, movements,
    };
  }

  get(user: SessionUser, id: number) {
    const shift = this.detail(id);
    if (user.role !== 'admin' && shift.openedBy !== user.id) throw forbidden('Only your own shift history is available');
    return shift;
  }

  list(user: SessionUser): CashShift[] {
    const rows = this.ctx.db.prepare(`SELECT id FROM cash_shifts ${user.role === 'admin' ? '' : 'WHERE opened_by = ?'} ORDER BY id DESC LIMIT 50`)
      .all(...(user.role === 'admin' ? [] : [user.id])) as { id: number }[];
    return rows.map((r) => this.detail(r.id));
  }

  private canManage(user: SessionUser, shift: CashShift) {
    if (user.role !== 'admin' && shift.openedBy !== user.id) throw forbidden('Only the shift owner or an administrator can manage this shift');
    if (shift.closedAt) throw conflict('This shift is already closed');
  }

  open(user: SessionUser, input: unknown): CashShift {
    const p = openShiftSchema.parse(input);
    return tx(this.ctx.db, () => {
      if (this.current()) throw conflict('A till shift is already open. Close it before handing over.');
      const result = this.ctx.db.prepare('INSERT INTO cash_shifts (opened_by, opened_at, opening_paisa, is_demo) VALUES (?, ?, ?, ?)')
        .run(user.id, this.ctx.clock.now().toISOString(), p.openingPaisa, new SettingsRepo(this.ctx).isDemo());
      const id = Number(result.lastInsertRowid);
      new AuditRepo(this.ctx).log({ action: 'shift.opened', entityType: 'shift', entityId: id, userId: user.id, details: p });
      return this.detail(id);
    });
  }

  move(user: SessionUser, input: unknown): CashShift {
    const p = cashMovementSchema.parse(input);
    return tx(this.ctx.db, () => {
      const shift = this.detail(p.shiftId);
      if (user.role !== 'admin' && shift.openedBy !== user.id) throw forbidden();
      const existing = this.ctx.db.prepare('SELECT * FROM cash_movements WHERE client_txn_id = ?').get(p.clientTxnId) as {
        shift_id: number; kind: string; amount_paisa: number; reason: string; created_by: number;
      } | undefined;
      if (existing) {
        if (existing.shift_id !== p.shiftId || existing.kind !== p.kind || existing.amount_paisa !== p.amountPaisa || existing.reason !== p.reason || existing.created_by !== user.id) throw conflict('This cash transaction ID was already used');
        return shift;
      }
      this.canManage(user, shift);
      if (p.kind === 'out' && p.amountPaisa > shift.expectedPaisa) throw invalid('Cash out exceeds the expected cash in the drawer');
      this.ctx.db.prepare(`INSERT INTO cash_movements (client_txn_id, shift_id, kind, amount_paisa, reason, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(p.clientTxnId, p.shiftId, p.kind, p.amountPaisa, p.reason, user.id, this.ctx.clock.now().toISOString());
      new AuditRepo(this.ctx).log({ action: `shift.cash_${p.kind}`, entityType: 'shift', entityId: p.shiftId, userId: user.id, details: p });
      return this.detail(p.shiftId);
    });
  }

  close(user: SessionUser, input: unknown): CashShift {
    const p = closeShiftSchema.parse(input);
    return tx(this.ctx.db, () => {
      const shift = this.detail(p.shiftId);
      if (user.role !== 'admin' && shift.openedBy !== user.id) throw forbidden();
      if (shift.closedAt && shift.countedPaisa === p.countedPaisa && shift.expectedPaisa === p.expectedPaisa && shift.closingNote === p.note) return shift;
      this.canManage(user, shift);
      if (shift.expectedPaisa !== p.expectedPaisa) throw conflict('Till totals changed. Refresh and review the closing amounts again.');
      if (p.countedPaisa !== shift.expectedPaisa && p.note.length < 3) throw invalid('Explain the cash difference in the closing note');
      this.ctx.db.prepare(`UPDATE cash_shifts SET closed_by = ?, closed_at = ?, counted_paisa = ?, expected_paisa = ?, closing_note = ? WHERE id = ?`)
        .run(user.id, this.ctx.clock.now().toISOString(), p.countedPaisa, shift.expectedPaisa, p.note, p.shiftId);
      new AuditRepo(this.ctx).log({ action: 'shift.closed', entityType: 'shift', entityId: p.shiftId, userId: user.id, details: { ...p, variancePaisa: p.countedPaisa - shift.expectedPaisa } });
      return this.detail(p.shiftId);
    });
  }
}
