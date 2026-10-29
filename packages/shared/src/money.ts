/** All money is stored and computed as integer paisa (1 NPR = 100 paisa). */
export type Paisa = number;

const grouping = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatNPR(paisa: Paisa, symbol = 'Rs.'): string {
  if (!Number.isFinite(paisa)) return `${symbol} —`;
  const sign = paisa < 0 ? '-' : '';
  return `${sign}${symbol} ${grouping.format(Math.abs(paisa) / 100)}`;
}

/** Plain number string without symbol, e.g. "1,250.00". */
export function formatAmount(paisa: Paisa): string {
  return grouping.format(paisa / 100);
}

/**
 * Parse a rupee amount typed by a user ("1250", "1,250.5", "Rs 99.99") into paisa.
 * Returns null for invalid input or more than 2 decimal places.
 */
export function parseRupees(input: string | number): Paisa | null {
  const text = String(input).replace(/rs\.?|npr|,|\s/gi, '');
  if (!/^-?\d+(\.\d{0,2})?$/.test(text)) return null;
  const negative = text.startsWith('-');
  const [whole = '0', frac = ''] = text.replace('-', '').split('.');
  const value = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  if (!Number.isSafeInteger(value)) return null;
  return negative ? -value : value;
}

export function paisaToRupeesInput(paisa: Paisa): string {
  return (paisa / 100).toFixed(2);
}

/** Basis points helper: 1% = 100 bp. Rounds half away from zero to whole paisa. */
export function applyBasisPoints(amount: Paisa, bp: number): Paisa {
  const raw = (amount * bp) / 10000;
  return Math.sign(raw) * Math.round(Math.abs(raw));
}
