import type { FiscalContext, FiscalYearRow } from '@srmart/shared';
import { fiscalProgress, fiscalYearForDate, parseLocalISODate, toBsDate, toLocalISODate } from '@srmart/shared';
import type { Ctx } from '../context';

export interface FiscalYearRecord {
  code: string;
  startDate: string;
  endDate: string;
  source: 'computed' | 'manual';
}

/**
 * Fiscal years follow Nepal's Bikram Sambat year: 1 Shrawan to the last day of Ashadh.
 * Boundaries are computed from the BS calendar and stored, so every sale/purchase/return
 * is permanently tagged with the fiscal year it was recorded in.
 */
export class FiscalService {
  constructor(private ctx: Ctx) {}

  /** Returns (creating if needed) the fiscal year containing a local AD date. Call inside the write transaction. */
  forDate(isoDate: string): FiscalYearRecord {
    const row = this.ctx.db
      .prepare('SELECT code, start_date, end_date, source FROM fiscal_years WHERE start_date <= ? AND end_date >= ?')
      .get(isoDate, isoDate) as { code: string; start_date: string; end_date: string; source: 'computed' | 'manual' } | undefined;
    if (row) return { code: row.code, startDate: row.start_date, endDate: row.end_date, source: row.source };
    const fy = fiscalYearForDate(parseLocalISODate(isoDate));
    this.ctx.db
      .prepare("INSERT OR IGNORE INTO fiscal_years (code, start_date, end_date, source, created_at) VALUES (?, ?, ?, 'computed', ?)")
      .run(fy.code, fy.startDate, fy.endDate, this.ctx.clock.now().toISOString());
    return { code: fy.code, startDate: fy.startDate, endDate: fy.endDate, source: 'computed' };
  }

  current(): FiscalContext {
    const now = this.ctx.clock.now();
    const today = toLocalISODate(now);
    const fy = fiscalYearForDate(now);
    const stored = this.forDate(today);
    const merged = { ...fy, code: stored.code, label: `FY ${stored.code}`, startDate: stored.startDate, endDate: stored.endDate };
    const bs = toBsDate(now);
    return { ...merged, ...fiscalProgress(merged, now), todayAd: today, todayBs: bs.text, todayBsLong: bs.long };
  }

  list(): FiscalYearRow[] {
    this.current();
    const currentCode = this.forDate(toLocalISODate(this.ctx.clock.now())).code;
    return (
      this.ctx.db
        .prepare(
          `SELECT f.*, (SELECT COUNT(*) FROM sales s WHERE s.fiscal_year = f.code) AS sale_count FROM fiscal_years f ORDER BY f.start_date DESC`,
        )
        .all() as Record<string, unknown>[]
    ).map((r) => ({
      code: r.code as string,
      startDate: r.start_date as string,
      endDate: r.end_date as string,
      source: r.source as 'computed' | 'manual',
      saleCount: r.sale_count as number,
      isCurrent: r.code === currentCode,
    }));
  }
}
