import type { AppSettings, SaleDetail } from '@srmart/shared';
import { formatAmount, formatNPR } from '@srmart/shared';
import { barcodeSvg, esc, PRINT_BASE_CSS } from './html';

export const maskPhone = (p: string) => (p.length > 4 ? `${'•'.repeat(Math.max(0, p.length - 3))}${p.slice(-3)}` : p);

export function renderReceiptHtml(sale: SaleDetail, settings: AppSettings, opts: { dataMode: 'demo' | 'live'; reprint?: boolean }): string {
  const w = settings.receipt.paperWidthMm;
  const contentW = w === 80 ? 72 : 48;
  const sym = settings.currency.symbol;
  const st = settings.store;
  const created = new Date(sale.createdAt);
  const time = created.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const pay = sale.payments.find((p) => p.kind === 'payment');
  const methodLabel = settings.paymentMethods.find((m) => m.code === pay?.method)?.label ?? pay?.method ?? '';
  const demo = opts.dataMode === 'demo' || sale.isDemo;
  const items = sale.items
    .map(
      (i) => `<div class="item"><div class="iname">${esc(i.name)}</div>
      <div class="irow"><span>${i.quantity} ${esc(i.unit)} × ${formatAmount(i.unitPricePaisa)}</span><span>${formatAmount(i.unitPricePaisa * i.quantity)}</span></div>
      ${i.promoDiscountPaisa ? `<div class="irow muted"><span>  ${esc(i.promotionName ?? 'Offer')}</span><span>-${formatAmount(i.promoDiscountPaisa)}</span></div>` : ''}
      ${i.discountPaisa - i.promoDiscountPaisa ? `<div class="irow muted"><span>  discount</span><span>-${formatAmount(i.discountPaisa - i.promoDiscountPaisa)}</span></div>` : ''}
      ${i.returnedQuantity ? `<div class="irow muted"><span>  returned ${i.returnedQuantity}</span><span></span></div>` : ''}</div>`,
    )
    .join('');
  const line = (label: string, value: string, cls = '') => `<div class="tot ${cls}"><span>${esc(label)}</span><span>${esc(value)}</span></div>`;
  const taxLine = sale.taxPaisa > 0 ? line(`${sale.taxLabel ?? 'Tax'} ${sale.taxRateBp / 100}%${sale.taxInclusive ? ' (incl.)' : ''}`, formatAmount(sale.taxPaisa)) : '';
  const refunded = sale.payments.filter((p) => p.kind === 'refund').reduce((a, p) => a + p.amountPaisa, 0);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(sale.receiptNo)}</title><style>
${PRINT_BASE_CSS}
@page{size:${w}mm auto;margin:0}
body{width:${w}mm}
.r{width:${contentW}mm;margin:0 auto;padding:3mm 0 6mm;font-size:${w === 80 ? 9 : 8}pt;line-height:1.35}
.c{text-align:center}.b{font-weight:700}.muted{color:#333}
.store{font-size:13pt;font-weight:800;letter-spacing:.5px}
hr{border:0;border-top:1px dashed #000;margin:2mm 0}
.irow,.tot,.kv{display:flex;justify-content:space-between;gap:2mm}
.iname{font-weight:600}
.grand{font-size:12pt;font-weight:800;margin-top:1mm}
.demo{border:2px solid #000;text-align:center;font-weight:800;padding:1mm;margin:2mm 0}
.small{font-size:7pt}
.bc svg{width:70%;height:9mm;margin:2mm auto 0}
@media screen{html{background:#e5e7eb}body{background:#fff;margin:12px auto;box-shadow:0 2px 8px rgba(0,0,0,.15)}}
</style></head><body><div class="r">
<div class="c store">${esc(st.name)}</div>
${st.tagline ? `<div class="c small">${esc(st.tagline)}</div>` : ''}
${st.address ? `<div class="c">${esc(st.address)}</div>` : ''}
${st.phone ? `<div class="c">Tel: ${esc(st.phone)}</div>` : ''}
${st.panVat ? `<div class="c">PAN/VAT: ${esc(st.panVat)}</div>` : ''}
${settings.receipt.header ? `<div class="c small" style="margin-top:1mm">${esc(settings.receipt.header)}</div>` : ''}
${demo ? '<div class="demo">DEMO / TRAINING RECEIPT<br/>NOT A VALID BILL</div>' : ''}
<hr/>
<div class="c b">SALES RECEIPT${opts.reprint ? ' (REPRINT)' : ''}</div>
<div class="kv"><span>Receipt</span><span class="b">${esc(sale.receiptNo)}</span></div>
<div class="kv"><span>Date</span><span>${esc(sale.businessDate)} ${esc(time)}</span></div>
${settings.receipt.showBsDate ? `<div class="kv"><span>Miti (BS)</span><span>${esc(sale.bsDate)}</span></div>` : ''}
<div class="kv"><span>Fiscal year</span><span>${esc(sale.fiscalYear)}</span></div>
<div class="kv"><span>Cashier</span><span>${esc(sale.cashierName)}</span></div>
${sale.customerName ? `<div class="kv"><span>Customer</span><span>${esc(sale.customerName)}</span></div>` : ''}
<hr/>${items}<hr/>
${line('Subtotal', formatAmount(sale.subtotalPaisa))}
${sale.promoDiscountPaisa ? line('Festival offers', `-${formatAmount(sale.promoDiscountPaisa)}`) : ''}
${sale.discountPaisa - sale.promoDiscountPaisa ? line('Discount', `-${formatAmount(sale.discountPaisa - sale.promoDiscountPaisa)}`) : ''}
${sale.discountPaisa ? `<div class="c small">You saved ${esc(formatNPR(sale.discountPaisa, sym))}</div>` : ''}
${taxLine}
${line('TOTAL', formatNPR(sale.totalPaisa, sym), 'grand')}
${pay ? line(`Paid (${methodLabel})`, formatAmount(pay.tenderedPaisa ?? pay.amountPaisa)) : ''}
${pay && pay.changePaisa ? line('Change', formatAmount(pay.changePaisa)) : ''}
${pay?.reference ? line('Ref', pay.reference) : ''}
${sale.status === 'voided' ? `<div class="demo">VOIDED — ${esc(sale.voidReason ?? '')}</div>` : ''}
${refunded && sale.status !== 'voided' ? line('Refunded', `-${formatAmount(refunded)}`) : ''}
${sale.coupons.length ? `<hr/><div class="c b">LUCKY DRAW COUPON${sale.coupons.length > 1 ? 'S' : ''}</div>
<div class="c small">${esc(sale.coupons[0]!.schemeName)}${sale.customer ? ` · ${esc(sale.customer.name)} (${esc(maskPhone(sale.customer.phone))})` : ''}</div>
<div class="c b" style="font-family:monospace;margin-top:1mm">${sale.coupons.map((c) => esc(c.couponNo)).join('<br/>')}</div>
<div class="c small">Keep this receipt. Coupons are void if the sale is voided or fully returned.</div>` : ''}
<hr/>
${settings.receipt.footer ? `<div class="c">${esc(settings.receipt.footer)}</div>` : ''}
<div class="bc">${barcodeSvg(sale.receiptNo, 'CODE128', { heightMm: 8 })}</div>
${!settings.tax.verified ? '<div class="c small" style="margin-top:1mm">Not a tax invoice. Billing format pending IRD verification.</div>' : ''}
<div class="c small" style="margin-top:1mm">Powered by Nayaro Tech</div>
</div></body></html>`;
}
