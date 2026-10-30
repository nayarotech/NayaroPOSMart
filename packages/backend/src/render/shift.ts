import type { AppSettings, CashShift } from '@srmart/shared';
import { formatNPR } from '@srmart/shared';
import { esc, PRINT_BASE_CSS } from './html';

export function renderShiftHtml(shift: CashShift, settings: AppSettings): string {
  const row = (label: string, amount: number) => `<tr><td>${esc(label)}</td><td class="amount">${esc(formatNPR(amount))}</td></tr>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Shift ${shift.id}</title><style>${PRINT_BASE_CSS}
    @page{size:A4;margin:15mm}body{padding:10mm;font-size:12px}h1,h2,p{margin-bottom:10px}table{width:100%;border-collapse:collapse;margin-bottom:18px}td,th{padding:7px;border-bottom:1px solid #ddd;text-align:left}.amount{text-align:right}h2{font-size:16px}
    </style></head><body><h1>${esc(settings.store.name)}</h1><h2>Shift #${shift.id} — ${shift.closedAt ? 'Closing report' : 'Open shift snapshot'}</h2>
    <p>Opened by ${esc(shift.openedByName)} · ${esc(shift.openedAt)}<br>Closed by ${esc(shift.closedByName ?? '—')} · ${esc(shift.closedAt ?? 'Still open')}</p>
    <table>${row('Opening float', shift.openingPaisa)}${row('Cash in', shift.cashInPaisa)}${row('Cash out', -shift.cashOutPaisa)}${row('Expected cash', shift.expectedPaisa)}${shift.countedPaisa === null ? '' : row('Counted cash', shift.countedPaisa) + row('Variance (counted − expected)', shift.variancePaisa! )}</table>
    <h2>Payments during this shift</h2><table><tr><th>Method</th><th class="amount">Received</th><th class="amount">Refunded</th></tr>${shift.payments.map((p) => `<tr><td>${esc(p.method)}</td><td class="amount">${esc(formatNPR(p.receivedPaisa))}</td><td class="amount">${esc(formatNPR(p.refundedPaisa))}</td></tr>`).join('')}</table>
    <h2>Cash movements</h2><table>${shift.movements.map((m) => row(`${m.kind.toUpperCase()} · ${m.reason} · ${m.userName} · ${m.createdAt}`, m.kind === 'out' ? -m.amountPaisa : m.amountPaisa)).join('')}</table>
    <p>Closing note: ${esc(shift.closingNote ?? '—')}</p><p>Expected cash = opening float + cash payments − cash refunds + cash in − cash out. Cash payments use the sale amount after change. Transactions made without an open shift are excluded.</p></body></html>`;
}
