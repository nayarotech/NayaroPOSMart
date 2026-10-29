import type { AuditEntry, Page } from '@srmart/shared';
import type { Ctx } from '../context';

export interface AuditInput {
  action: string;
  entityType: string;
  entityId?: string | number | null;
  userId?: number | null;
  approvedBy?: number | null;
  details?: Record<string, unknown> | null;
}

const SECRET_KEYS = /pass(word)?|secret|token|hash/i;

function scrub(details: Record<string, unknown> | null | undefined) {
  if (!details) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(details)) out[k] = SECRET_KEYS.test(k) ? '[redacted]' : v;
  return JSON.stringify(out);
}

export class AuditRepo {
  constructor(private ctx: Ctx) {}

  log(e: AuditInput) {
    this.ctx.db
      .prepare(
        `INSERT INTO audit_logs (action, entity_type, entity_id, user_id, approved_by, details, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(e.action, e.entityType, e.entityId == null ? null : String(e.entityId), e.userId ?? null, e.approvedBy ?? null, scrub(e.details), this.ctx.clock.now().toISOString());
  }

  list(opts: { page: number; pageSize: number; action?: string }): Page<AuditEntry> {
    const where = opts.action ? 'WHERE a.action LIKE ?' : '';
    const params: unknown[] = opts.action ? [`${opts.action}%`] : [];
    const total = (this.ctx.db.prepare(`SELECT COUNT(*) n FROM audit_logs a ${where}`).get(...params) as { n: number }).n;
    const rows = this.ctx.db
      .prepare(
        `SELECT a.*, u.full_name AS user_name, ap.full_name AS approved_name
         FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN users ap ON ap.id = a.approved_by
         ${where} ORDER BY a.id DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, opts.pageSize, (opts.page - 1) * opts.pageSize) as Record<string, unknown>[];
    return {
      total,
      page: opts.page,
      pageSize: opts.pageSize,
      rows: rows.map((r) => ({
        id: r.id as number,
        action: r.action as string,
        entityType: r.entity_type as string,
        entityId: (r.entity_id as string) ?? null,
        userName: (r.user_name as string) ?? null,
        approvedByName: (r.approved_name as string) ?? null,
        details: r.details ? (JSON.parse(r.details as string) as Record<string, unknown>) : null,
        createdAt: r.created_at as string,
      })),
    };
  }
}
