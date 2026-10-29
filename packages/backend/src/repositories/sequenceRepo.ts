import type { Ctx } from '../context';

/**
 * Gap-free counters. Must be called inside the caller's write transaction so the number
 * is only consumed if the whole sale/return/purchase commits.
 */
export class SequenceRepo {
  constructor(private ctx: Ctx) {}

  next(key: string): number {
    const now = this.ctx.clock.now().toISOString();
    const row = this.ctx.db
      .prepare(
        `INSERT INTO receipt_sequences (sequence_key, next_value, updated_at) VALUES (?, 2, ?)
         ON CONFLICT(sequence_key) DO UPDATE SET next_value = next_value + 1, updated_at = excluded.updated_at
         RETURNING next_value - 1 AS value`,
      )
      .get(key, now) as { value: number };
    return row.value;
  }

  nextId(name: string): number {
    const row = this.ctx.db
      .prepare(
        `INSERT INTO id_sequences (name, next_value) VALUES (?, 2)
         ON CONFLICT(name) DO UPDATE SET next_value = next_value + 1
         RETURNING next_value - 1 AS value`,
      )
      .get(name) as { value: number };
    return row.value;
  }
}
