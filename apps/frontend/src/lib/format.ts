import { formatNPR, parseLocalISODate, toBsDate } from '@srmart/shared';

export const npr = (p: number) => formatNPR(p);
export const dateTime = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
export const timeOnly = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
export const bs = (isoDate: string) => toBsDate(parseLocalISODate(isoDate)).text;
export const bsLong = (isoDate: string) => toBsDate(parseLocalISODate(isoDate)).long;
export const pct = (bp: number) => `${(bp / 100).toFixed(1)}%`;
export const bytes = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`);
export const STATUS_LABEL: Record<string, string> = {
  completed: 'Completed',
  voided: 'Voided',
  partially_returned: 'Part returned',
  returned: 'Returned',
};
