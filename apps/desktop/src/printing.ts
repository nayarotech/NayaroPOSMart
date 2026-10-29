import { BrowserWindow, dialog, type WebContents } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PrinterInfo, PrintResult } from '@srmart/shared';

export type PrintMode = 'dialog' | 'pdf' | 'silent';

/**
 * Printer abstraction. Nothing here is vendor-specific: it prints HTML through the OS print
 * system (driver installed by the shop). Physical printer behaviour must be verified on site —
 * see docs/HARDWARE_TESTS.md. PDF export is always available as a fallback.
 */
export class PrinterService {
  constructor(private owner: () => BrowserWindow | null) {}

  async list(): Promise<PrinterInfo[]> {
    const win = this.owner();
    if (!win) return [];
    try {
      const printers = await win.webContents.getPrintersAsync();
      return printers.map((p) => ({
        name: p.name,
        displayName: p.displayName || p.name,
        isDefault: Boolean((p as unknown as { isDefault?: boolean }).isDefault ?? (p.options as Record<string, string> | undefined)?.['printer-is-default'] === 'true'),
        status: (p as unknown as { status?: number }).status ?? 0,
      }));
    } catch {
      return [];
    }
  }

  /** Loads print HTML in a hidden, script-disabled, sandboxed window from a temp file. */
  private async load(html: string): Promise<{ win: BrowserWindow; file: string }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srmart-print-'));
    const file = path.join(dir, 'print.html');
    fs.writeFileSync(file, html, 'utf8');
    const win = new BrowserWindow({
      show: false,
      width: 800,
      height: 1000,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false },
    });
    await win.loadFile(file);
    return { win, file };
  }

  private cleanup(win: BrowserWindow, file: string) {
    if (!win.isDestroyed()) win.destroy();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }

  async print(html: string, opts: { mode: PrintMode; printerName: string | null; title: string; widthMm?: number }): Promise<PrintResult> {
    if (opts.mode === 'pdf') return this.pdf(html, opts.title);
    if (opts.mode === 'silent') {
      if (!opts.printerName) return { ok: false, mode: 'cancelled', message: 'No printer is selected in Settings → Printers. Use "Print…" to choose one, or save as PDF.' };
      const available = await this.list();
      if (!available.some((p) => p.name === opts.printerName)) {
        return { ok: false, mode: 'cancelled', message: `Printer "${opts.printerName}" is not available (offline, renamed or driver missing). Use "Print…" or save as PDF.` };
      }
    }
    const { win, file } = await this.load(html);
    try {
      const result = await new Promise<{ success: boolean; reason: string }>((resolve) => {
        (win.webContents as WebContents).print(
          {
            silent: opts.mode === 'silent',
            deviceName: opts.mode === 'silent' ? opts.printerName ?? undefined : undefined,
            printBackground: true,
            margins: { marginType: 'none' },
          },
          (success, reason) => resolve({ success, reason }),
        );
      });
      if (result.success) {
        return { ok: true, mode: opts.mode === 'silent' ? 'printed' : 'dialog', message: opts.mode === 'silent' ? `Sent to ${opts.printerName}` : 'Sent to the printer' };
      }
      const cancelled = /cancel/i.test(result.reason);
      return { ok: false, mode: 'cancelled', message: cancelled ? 'Printing was cancelled' : `Printing failed: ${result.reason}. Check the printer, or save as PDF.` };
    } finally {
      this.cleanup(win, file);
    }
  }

  async pdf(html: string, title: string): Promise<PrintResult> {
    const owner = this.owner();
    const safe = title.replace(/[^a-z0-9._-]+/gi, '_').slice(0, 60);
    const target = await dialog.showSaveDialog(owner ?? undefined!, { title: 'Save as PDF', defaultPath: `${safe}.pdf`, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (target.canceled || !target.filePath) return { ok: false, mode: 'cancelled', message: 'Save cancelled' };
    const { win, file } = await this.load(html);
    try {
      const data = await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true, margins: { top: 0, bottom: 0, left: 0, right: 0 } });
      const tmp = `${target.filePath}.tmp`;
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, target.filePath);
      return { ok: true, mode: 'pdf', message: `Saved ${path.basename(target.filePath)}`, pdfPath: target.filePath };
    } finally {
      this.cleanup(win, file);
    }
  }
}
