import NepaliDateModule from 'nepali-date-converter';

// The package ships UMD + ES builds; normalise the default export across bundlers.
type NepaliDateCtor = new (...args: unknown[]) => {
  getYear(): number;
  getMonth(): number;
  getDate(): number;
  format(fmt: string): string;
  toJsDate(): Date;
};
const NepaliDate: NepaliDateCtor =
  ((NepaliDateModule as unknown as { default?: NepaliDateCtor }).default ?? NepaliDateModule) as unknown as NepaliDateCtor;

export const BS_MONTHS = [
  'Baishakh', 'Jestha', 'Ashadh', 'Shrawan', 'Bhadra', 'Ashwin',
  'Kartik', 'Mangsir', 'Poush', 'Magh', 'Falgun', 'Chaitra',
] as const;

/** Nepal's fiscal year starts on 1 Shrawan (BS month index 3). */
const SHRAWAN = 3;

export interface FiscalYearInfo {
  /** e.g. "2083/84" */
  code: string;
  label: string;
  bsStartYear: number;
  /** Local AD date, inclusive, YYYY-MM-DD */
  startDate: string;
  /** Local AD date, inclusive, YYYY-MM-DD */
  endDate: string;
  bsStart: string;
  bsEnd: string;
}

export function toLocalISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function parseLocalISODate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12, 0, 0);
}

export function fiscalCode(bsStartYear: number): string {
  return `${bsStartYear}/${String((bsStartYear + 1) % 100).padStart(2, '0')}`;
}

/** Computes the Nepal fiscal year (Shrawan 1 – Ashadh end, Bikram Sambat) that the BS start year names. */
export function fiscalYearFromBsYear(bsStartYear: number): FiscalYearInfo {
  const start = new NepaliDate(bsStartYear, SHRAWAN, 1).toJsDate();
  const nextStart = new NepaliDate(bsStartYear + 1, SHRAWAN, 1).toJsDate();
  const end = new Date(nextStart.getFullYear(), nextStart.getMonth(), nextStart.getDate() - 1, 12);
  const code = fiscalCode(bsStartYear);
  return {
    code,
    label: `FY ${code}`,
    bsStartYear,
    startDate: toLocalISODate(start),
    endDate: toLocalISODate(end),
    bsStart: `${bsStartYear}-04-01`,
    bsEnd: new NepaliDate(end).format('YYYY-MM-DD'),
  };
}

export function fiscalYearForDate(date: Date): FiscalYearInfo {
  const bs = new NepaliDate(new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12));
  const startYear = bs.getMonth() >= SHRAWAN ? bs.getYear() : bs.getYear() - 1;
  return fiscalYearFromBsYear(startYear);
}

export function toBsDate(date: Date): { year: number; month: number; day: number; text: string; long: string } {
  const bs = new NepaliDate(new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12));
  const month = bs.getMonth();
  return {
    year: bs.getYear(),
    month: month + 1,
    day: bs.getDate(),
    text: bs.format('YYYY-MM-DD'),
    long: `${bs.getDate()} ${BS_MONTHS[month]} ${bs.getYear()}`,
  };
}

/** Day number within the fiscal year and its length, for "running" progress displays. */
export function fiscalProgress(fy: { startDate: string; endDate: string }, today: Date = new Date()) {
  const start = parseLocalISODate(fy.startDate).getTime();
  const end = parseLocalISODate(fy.endDate).getTime();
  const now = parseLocalISODate(toLocalISODate(today)).getTime();
  const dayMs = 86_400_000;
  const totalDays = Math.round((end - start) / dayMs) + 1;
  const dayNumber = Math.min(totalDays, Math.max(0, Math.round((now - start) / dayMs) + 1));
  return { dayNumber, totalDays, daysLeft: totalDays - dayNumber, percent: Math.round((dayNumber / totalDays) * 100) };
}
