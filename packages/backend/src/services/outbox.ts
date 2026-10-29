import crypto from 'node:crypto';
import type { Ctx } from '../context';

/**
 * Future-sync scaffold. Events are written in the same transaction as the business change,
 * carry a stable UUID for idempotent processing, and are never required for checkout.
 * No remote sync is implemented in this MVP; nothing ever overwrites local sales.
 */
export class Outbox {
  constructor(private ctx: Ctx) {}

  enqueue(eventType: string, aggregateType: string, aggregateId: string | number, payload: Record<string, unknown>) {
    const now = this.ctx.clock.now().toISOString();
    this.ctx.db
      .prepare(
        `INSERT INTO sync_outbox (event_id, event_type, aggregate_type, aggregate_id, payload, status, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
      )
      .run(crypto.randomUUID(), eventType, aggregateType, String(aggregateId), JSON.stringify(payload), now, now);
  }

  pendingCount(): number {
    return (this.ctx.db.prepare("SELECT COUNT(*) n FROM sync_outbox WHERE status != 'sent'").get() as { n: number }).n;
  }
}
