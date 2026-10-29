import bwipjs from 'bwip-js';
import type { Symbology } from '@srmart/shared';

export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const BCID: Record<Symbology, string> = { EAN13: 'ean13', UPCA: 'upca', EAN8: 'ean8', CODE128: 'code128', OTHER: 'code128' };

/** Real barcode vector graphics from bwip-js (Barcode Writer in Pure PostScript). */
export function barcodeSvg(code: string, symbology: Symbology, opts: { heightMm?: number; text?: boolean } = {}): string {
  const render = (bcid: string) =>
    bwipjs.toSVG({
      bcid,
      text: code,
      scale: 2,
      height: opts.heightMm ?? 10,
      includetext: opts.text ?? false,
      textxalign: 'center',
      paddingwidth: 0,
      paddingheight: 0,
    });
  try {
    return render(BCID[symbology]);
  } catch {
    // e.g. a stored value that fails EAN check rules: fall back to Code 128 which encodes any ASCII.
    return render('code128');
  }
}

export const PRINT_BASE_CSS = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:#fff;color:#000;font-family:"Helvetica Neue",Arial,"Noto Sans Devanagari",sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
svg{display:block}
`;
