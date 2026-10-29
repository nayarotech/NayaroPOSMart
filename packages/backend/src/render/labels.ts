import type { AppSettings, LabelSize, Product } from '@srmart/shared';
import { formatNPR, toLocalISODate } from '@srmart/shared';
import { barcodeSvg, esc, PRINT_BASE_CSS } from './html';

export type LabelTemplate = 'sticker' | 'shelf';

function primaryCode(p: Product) {
  const b = p.barcodes.find((x) => x.isPrimary) ?? p.barcodes[0];
  return b ? { code: b.code, symbology: b.symbology } : { code: p.sku, symbology: 'CODE128' as const };
}

function sticker(p: Product, s: LabelSize, symbol: string) {
  const { code, symbology } = primaryCode(p);
  const barH = Math.max(6, Math.min(14, s.heightMm * 0.38));
  return `<div class="label sticker">
    <div class="name">${esc(p.name)}</div>
    <div class="row"><span class="price">${esc(formatNPR(p.pricePaisa, symbol))}</span><span class="unit">/${esc(p.unit)}</span></div>
    <div class="bc">${barcodeSvg(code, symbology, { heightMm: barH })}</div>
    <div class="meta"><span>${esc(code)}</span><span>${esc(p.sku)}</span></div>
  </div>`;
}

function shelf(p: Product, s: LabelSize, symbol: string, date: string) {
  const { code, symbology } = primaryCode(p);
  const barH = Math.max(5, Math.min(10, s.heightMm * 0.2));
  return `<div class="label shelf">
    <div class="name">${esc(p.name)}</div>
    ${p.brand ? `<div class="brand">${esc(p.brand)}</div>` : ''}
    <div class="price">${esc(formatNPR(p.pricePaisa, symbol))}<span class="unit"> / ${esc(p.unit)}</span></div>
    <div class="foot">
      <div class="bc">${barcodeSvg(code, symbology, { heightMm: barH })}</div>
      <div class="meta"><div>${esc(p.sku)}</div><div>${esc(code)}</div><div>Price as of ${esc(date)}</div></div>
    </div>
  </div>`;
}

export function renderLabelsHtml(template: LabelTemplate, items: { product: Product; copies: number }[], settings: AppSettings, today = new Date()): string {
  const size = settings.labels[template];
  const symbol = settings.currency.symbol;
  const date = toLocalISODate(today);
  const body = items.flatMap(({ product, copies }) =>
    Array.from({ length: copies }, () => (template === 'sticker' ? sticker(product, size, symbol) : shelf(product, size, symbol, date))),
  );
  const roll = size.columns === 1;
  // Roll printers: one label per page sized exactly to the label. Sheets: grid on the page width.
  const pageCss = roll
    ? `@page{size:${size.widthMm}mm ${size.heightMm}mm;margin:0}
       .sheet{display:block}.label{page-break-after:always;break-after:page}`
    : `@page{size:${size.pageWidthMm}mm auto;margin:${size.marginMm}mm}
       .sheet{display:grid;grid-template-columns:repeat(${size.columns},${size.widthMm}mm);gap:${size.gapMm}mm}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Labels</title><style>
${PRINT_BASE_CSS}
${pageCss}
.label{width:${size.widthMm}mm;height:${size.heightMm}mm;padding:${roll ? size.marginMm : 1.5}mm;overflow:hidden;display:flex;flex-direction:column;border:${roll ? '0' : '0.2mm dashed #999'};}
.name{font-weight:700;line-height:1.1;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.sticker .name{font-size:${Math.max(6, size.heightMm * 0.22)}pt}
.sticker .row{display:flex;align-items:baseline;gap:1mm;margin:0.5mm 0}
.sticker .price{font-size:${Math.max(8, size.heightMm * 0.36)}pt;font-weight:800}
.unit{font-size:7pt;font-weight:400}
.bc{flex:1;min-height:0;display:flex;align-items:center}
.bc svg{width:100%;height:100%;max-height:100%}
.meta{display:flex;justify-content:space-between;font-size:6pt;font-family:Menlo,Consolas,monospace}
.shelf .name{font-size:${Math.max(8, size.heightMm * 0.3)}pt}
.shelf .brand{font-size:7pt;color:#333}
.shelf .price{font-size:${Math.max(14, size.heightMm * 0.62)}pt;font-weight:900;margin:auto 0 1mm}
.shelf .foot{display:flex;gap:2mm;align-items:flex-end;height:${Math.max(7, size.heightMm * 0.28)}mm}
.shelf .foot .bc{flex:0 0 55%;height:100%}
.shelf .meta{flex-direction:column;align-items:flex-end;flex:1;text-align:right}
@media screen{body{background:#f3f4f6;padding:8mm}.sheet{gap:${roll ? '4mm' : `${size.gapMm}mm`};display:${roll ? 'flex' : 'grid'};flex-wrap:wrap}.label{background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.2);border:0}}
</style></head><body><div class="sheet">${body.join('')}</div></body></html>`;
}
