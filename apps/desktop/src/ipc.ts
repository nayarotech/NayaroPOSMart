import { app, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { lanUrls, qrSvg, renderLabelsHtml, renderReceiptHtml, requireRole, toAppError, AppError, verifyPassword } from '@srmart/backend';
import type { ApiChannel, ApiEnvelope, ApiIn, ApiOut, Role, ScannerStatus, SessionUser } from '@srmart/shared';
import { API_CHANNELS, changePasswordSchema, labelJobSchema } from '@srmart/shared';
import type { AppState } from './appState';
import { log } from './log';
import type { PrinterService } from './printing';

type Access = 'public' | 'user' | Role;
type Ctx<K extends ApiChannel> = { user: SessionUser | null; input: ApiIn<K>; event: IpcMainInvokeEvent };
type Handler<K extends ApiChannel> = { access: Access; run: (c: Ctx<K>) => ApiOut<K> | Promise<ApiOut<K>> };
type Handlers = { [K in ApiChannel]: Handler<K> };

const MAX_PAYLOAD_BYTES = 6_000_000;
const ALLOWED_WHEN_PASSWORD_CHANGE_REQUIRED = new Set<ApiChannel>(['auth.session', 'auth.logout', 'auth.changePassword', 'app.info']);

export function registerIpc(state: AppState, printers: PrinterService, isTrustedUrl: (url: string) => boolean) {
  /** Signed-in user per renderer. Lives only in the main process. */
  const sessions = new Map<number, number>();
  const s = () => state.services;
  const u = (c: { user: SessionUser | null }) => c.user!;
  const num = (v: unknown, name = 'id') => {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new AppError('VALIDATION', `Invalid ${name}`);
    return n;
  };

  const scannerStatus = (): ScannerStatus => {
    const cfg = s().settings.get().scanner;
    const running = state.scanner?.running ?? false;
    const urls = running ? lanUrls(cfg.phonePort).map((u) => u.replace('http://', 'https://')) : [];
    const pairing = running ? state.scanner!.pairingInfo() : null;
    const pairUrl = pairing && urls[0] ? `${urls[0]}/scanner.html#pair=${pairing.token}` : null;
    return {
      usbEnabled: cfg.usbEnabled,
      phoneEnabled: cfg.phoneEnabled,
      running,
      port: cfg.phonePort,
      urls,
      message: running
        ? urls.length ? 'Phone scanner ready on the shop network' : 'Running, but this computer has no network address — connect it to the shop Wi-Fi/LAN'
        : cfg.phoneEnabled ? 'Enabled but not running — check the port in Settings' : 'Phone scanner is turned off in Settings',
      devices: state.scanner?.listDevices() ?? [],
      pairing: pairing && pairUrl ? { url: pairUrl, qrSvg: qrSvg(pairUrl), expiresAt: pairing.expiresAt } : null,
    };
  };

  const handlers: Handlers = {
    'auth.login': {
      access: 'public',
      run: ({ input, event }) => {
        const user = s().auth.login(input);
        sessions.set(event.sender.id, user.id);
        return user;
      },
    },
    'auth.logout': {
      access: 'public',
      run: ({ user, event }) => {
        if (user) s().audit.log({ action: 'auth.logout', entityType: 'user', entityId: user.id, userId: user.id });
        sessions.delete(event.sender.id);
        return { ok: true };
      },
    },
    'auth.session': { access: 'public', run: ({ user }) => user },
    'auth.changePassword': {
      access: 'user',
      run: ({ user, input }) => {
        const p = changePasswordSchema.parse(input);
        s().auth.changePassword(u({ user }), p.currentPassword, p.newPassword);
        return { ok: true };
      },
    },
    'app.info': {
      access: 'public',
      run: ({ user }) => {
        const svc = s();
        return {
          version: app.getVersion(),
          dataMode: svc.settings.repo.getDataMode(),
          storeName: svc.settings.get().store.name,
          fiscal: svc.fiscal.current(),
          demoCredentialsActive: svc.users.repo.anyDefaultPasswords(),
          dbPath: user?.role === 'admin' ? state.dbPath : '',
          lastBackupAt: user?.role === 'admin' ? (state.backups.list()[0]?.createdAt ?? null) : null,
        };
      },
    },
    'dashboard.summary': { access: 'admin', run: () => s().reports.dashboard() },

    'categories.list': { access: 'user', run: () => s().products.repo.categories() },
    'categories.create': { access: 'admin', run: (c) => s().products.createCategory(u(c), c.input?.name) },

    'products.list': { access: 'user', run: ({ input }) => s().products.list(input) },
    'products.get': { access: 'user', run: ({ input }) => s().products.get(num(input?.id)) },
    'products.create': { access: 'admin', run: (c) => s().products.create(u(c), c.input) },
    'products.update': { access: 'admin', run: (c) => s().products.update(u(c), c.input) },
    'products.setActive': { access: 'admin', run: (c) => s().products.setActive(u(c), num(c.input?.id), Boolean(c.input?.active)) },
    'products.lookupBarcode': { access: 'user', run: ({ input }) => s().products.lookupBarcode(String(input?.code ?? '')) },
    'products.search': { access: 'user', run: ({ input }) => s().products.search(String(input?.q ?? ''), Number(input?.limit ?? 12)) },
    'products.importCsv': { access: 'admin', run: (c) => s().products.importCsv(u(c), String(c.input?.csv ?? ''), Boolean(c.input?.commit)) },
    'products.exportCsv': {
      access: 'admin',
      run: async (c) => {
        const { csv, count } = s().products.exportCsv();
        const res = await dialog.showSaveDialog({ title: 'Export products', defaultPath: `srmart-products-${new Date().toISOString().slice(0, 10)}.csv`, filters: [{ name: 'CSV', extensions: ['csv'] }] });
        if (res.canceled || !res.filePath) return { saved: false, path: null, count };
        fs.writeFileSync(`${res.filePath}.tmp`, `\uFEFF${csv}`, 'utf8');
        fs.renameSync(`${res.filePath}.tmp`, res.filePath);
        s().audit.log({ action: 'product.csv_export', entityType: 'product', userId: u(c).id, details: { count } });
        return { saved: true, path: res.filePath, count };
      },
    },

    'barcodes.add': { access: 'admin', run: (c) => s().products.addBarcode(u(c), num(c.input?.productId), String(c.input?.code ?? ''), c.input?.symbology) },
    'barcodes.generateInternal': { access: 'admin', run: (c) => s().products.generateInternalBarcode(u(c), num(c.input?.productId)) },
    'barcodes.remove': { access: 'admin', run: (c) => s().products.removeBarcode(u(c), num(c.input?.barcodeId)) },
    'barcodes.setPrimary': { access: 'admin', run: (c) => s().products.setPrimaryBarcode(u(c), num(c.input?.barcodeId)) },

    'labels.render': {
      access: 'user',
      run: ({ input }) => {
        const job = labelJobSchema.parse(input);
        const products = new Map(s().products.repo.byIds(job.items.map((i) => i.productId)).map((p) => [p.id, p]));
        const warnings: string[] = [];
        const items = job.items.flatMap((i) => {
          const product = products.get(i.productId);
          if (!product) return [];
          if (!product.active) warnings.push(`${product.name} is disabled`);
          if (!product.barcodes.length) warnings.push(`${product.name} has no barcode — its SKU is printed as Code 128`);
          return [{ product, copies: i.copies }];
        });
        return { html: renderLabelsHtml(job.template, items, s().settings.get()), labelCount: items.reduce((a, i) => a + i.copies, 0), warnings };
      },
    },
    'labels.print': {
      access: 'user',
      run: async (c) => {
        const job = labelJobSchema.parse(c.input);
        const mode = c.input?.mode === 'pdf' ? 'pdf' : c.input?.mode === 'silent' ? 'silent' : 'dialog';
        const products = new Map(s().products.repo.byIds(job.items.map((i) => i.productId)).map((p) => [p.id, p]));
        const items = job.items.flatMap((i) => (products.get(i.productId) ? [{ product: products.get(i.productId)!, copies: i.copies }] : []));
        const settings = s().settings.get();
        const result = await printers.print(renderLabelsHtml(job.template, items, settings), { mode, printerName: settings.printers.labelPrinter, title: `labels-${job.template}` });
        if (result.ok) {
          s().products.repo.markLabelsPrinted(items.map((i) => i.product.id));
          s().audit.log({ action: 'labels.printed', entityType: 'product', userId: u(c).id, details: { template: job.template, products: items.length, labels: items.reduce((a, i) => a + i.copies, 0), mode: result.mode } });
        }
        return result;
      },
    },
    'printers.list': { access: 'user', run: () => printers.list() },

    'sales.quote': { access: 'user', run: (c) => s().sales.quote(u(c), c.input) },
    'sales.complete': { access: 'user', run: (c) => s().sales.complete(u(c), c.input) },
    'sales.list': { access: 'user', run: ({ input }) => s().sales.list(input) },
    'sales.get': { access: 'user', run: ({ input }) => s().sales.get(num(input?.id)) },
    'sales.void': { access: 'user', run: (c) => s().sales.void(u(c), c.input) },
    'sales.return': { access: 'user', run: (c) => s().sales.createReturn(u(c), c.input) },
    'receipts.render': {
      access: 'user',
      run: ({ input }) => {
        const sale = s().sales.get(num(input?.saleId));
        return { html: renderReceiptHtml(sale, s().settings.get(), { dataMode: s().settings.repo.getDataMode() }) };
      },
    },
    'receipts.print': {
      access: 'user',
      run: async (c) => {
        const sale = s().sales.get(num(c.input?.saleId));
        const settings = s().settings.get();
        const mode = c.input?.mode === 'pdf' ? 'pdf' : c.input?.mode === 'silent' ? 'silent' : 'dialog';
        const html = renderReceiptHtml(sale, settings, { dataMode: s().settings.repo.getDataMode() });
        const r = await printers.print(html, { mode, printerName: settings.printers.receiptPrinter, title: sale.receiptNo.replace(/\//g, '-'), widthMm: settings.receipt.paperWidthMm });
        if (r.ok) s().audit.log({ action: 'receipt.printed', entityType: 'sale', entityId: sale.id, userId: u(c).id, details: { receiptNo: sale.receiptNo, mode: r.mode } });
        return r;
      },
    },

    'suppliers.list': { access: 'admin', run: () => s().purchases.repo.suppliers() },
    'suppliers.create': { access: 'admin', run: (c) => s().purchases.createSupplier(u(c), c.input) },
    'suppliers.update': { access: 'admin', run: (c) => s().purchases.updateSupplier(u(c), c.input) },
    'purchases.list': {
      access: 'admin',
      run: ({ input }) => s().purchases.repo.list({ page: Math.max(1, Number(input?.page ?? 1)), pageSize: Math.min(200, Math.max(5, Number(input?.pageSize ?? 25))), fiscalYear: input?.fiscalYear || undefined }),
    },
    'purchases.get': { access: 'admin', run: ({ input }) => s().purchases.get(num(input?.id)) },
    'purchases.create': { access: 'admin', run: (c) => s().purchases.receive(u(c), c.input) },

    'inventory.movements': { access: 'admin', run: ({ input }) => s().inventory.movements(input ?? {}) },
    'inventory.adjust': { access: 'admin', run: (c) => s().inventory.adjust(u(c), c.input) },
    'inventory.lowStock': { access: 'user', run: () => s().inventory.lowStock() },
    'inventory.expiring': { access: 'admin', run: ({ input }) => s().inventory.expiring(Number(input?.days ?? 30)) },

    'reports.sales': { access: 'admin', run: ({ input }) => s().reports.salesReport(input) },
    'reports.stockValuation': { access: 'admin', run: () => s().reports.stockValuation() },
    'reports.purchases': { access: 'admin', run: ({ input }) => s().reports.purchases(input) },
    'reports.returns': { access: 'admin', run: ({ input }) => s().reports.returns(input) },
    'reports.fiscalYears': { access: 'user', run: () => s().fiscal.list() },

    'users.list': { access: 'admin', run: (c) => s().users.list(u(c)) },
    'users.create': { access: 'admin', run: (c) => s().users.create(u(c), c.input) },
    'users.update': { access: 'admin', run: (c) => s().users.update(u(c), c.input) },
    'users.resetPassword': { access: 'admin', run: (c) => s().users.resetPassword(u(c), num(c.input?.id), String(c.input?.newPassword ?? '')) },
    'audit.list': {
      access: 'admin',
      run: ({ input }) => s().audit.list({ page: Math.max(1, Number(input?.page ?? 1)), pageSize: Math.min(200, Math.max(5, Number(input?.pageSize ?? 50))), action: input?.action ? String(input.action).slice(0, 50) : undefined }),
    },

    'settings.get': { access: 'user', run: () => s().settings.get() },
    'settings.update': {
      access: 'admin',
      run: async (c) => {
        const saved = s().settings.update(u(c), c.input);
        try {
          await state.syncMobileServer();
        } catch (err) {
          throw new AppError('CONFLICT', `Settings saved, but the mobile server could not start on port ${saved.mobile.port}: ${(err as Error).message}`);
        }
        try {
          await state.syncScannerServer();
        } catch (err) {
          throw new AppError('CONFLICT', `Settings saved, but the phone scanner could not start on port ${saved.scanner.phonePort}: ${(err as Error).message}`);
        }
        return saved;
      },
    },

    'backup.status': { access: 'admin', run: () => state.backups.status() },
    'backup.create': {
      access: 'admin',
      run: (c) => {
        const b = state.backups.create('manual');
        state.backups.prune(s().settings.get().backup.keep);
        s().audit.log({ action: 'backup.created', entityType: 'system', userId: u(c).id, details: { file: b.file } });
        return b;
      },
    },
    'backup.verify': { access: 'admin', run: ({ input }) => state.backups.verify(String(input?.file ?? '')) },
    'backup.testRestore': {
      access: 'admin',
      run: (c) => {
        const r = state.backups.testRestore(String(c.input?.file ?? ''));
        s().audit.log({ action: 'backup.test_restore', entityType: 'system', userId: u(c).id, details: { file: c.input?.file, ok: r.ok } });
        return r;
      },
    },
    'backup.restore': {
      access: 'admin',
      run: ({ user, input, event }) => {
        const me = s().users.repo.byId(user!.id);
        if (!me || !verifyPassword(String(input?.password ?? ''), me.passwordHash)) throw new AppError('UNAUTHENTICATED', 'Password is incorrect');
        const file = String(input?.file ?? '');
        const safetyBackup = state.restore(file);
        // The restored database may have different users; require a fresh sign-in.
        sessions.clear();
        s().audit.log({ action: 'backup.restored', entityType: 'system', details: { file, safetyBackup, restoredBy: me.username } });
        log.warn(`database restored from ${file}; safety backup ${safetyBackup}`);
        void event;
        return { ok: true, safetyBackup };
      },
    },
    'backup.chooseDirectory': {
      access: 'admin',
      run: async () => {
        const r = await dialog.showOpenDialog({ title: 'Choose backup folder (ideally a USB drive or second disk)', properties: ['openDirectory', 'createDirectory'] });
        const dir = r.canceled ? null : (r.filePaths[0] ?? null);
        if (dir && path.resolve(dir) === path.resolve(path.dirname(state.dbPath))) throw new AppError('VALIDATION', 'Choose a folder different from the database folder');
        return { directory: dir };
      },
    },
    'backup.openFolder': {
      access: 'admin',
      run: async () => {
        await shell.openPath(state.backups.dir());
        return { ok: true };
      },
    },

    'demo.reset': {
      access: 'admin',
      run: (c) => {
        s().demo.checkReset(u(c), String(c.input?.confirmText ?? ''), String(c.input?.password ?? ''));
        const b = state.backups.create('before-demo-reset');
        s().demo.applyReset(u(c), b.file);
        return { ok: true, backup: b.file };
      },
    },
    'demo.goLive': {
      access: 'admin',
      run: (c) => {
        s().demo.checkGoLive(u(c), String(c.input?.confirmText ?? ''), String(c.input?.password ?? ''));
        const b = state.backups.create('before-go-live');
        s().demo.applyGoLive(u(c), b.file);
        return { ok: true, backup: b.file };
      },
    },

    'promotions.list': { access: 'user', run: () => s().promotions.listPromotions() },
    'promotions.create': { access: 'admin', run: (c) => s().promotions.createPromotion(u(c), c.input) },
    'promotions.update': { access: 'admin', run: (c) => s().promotions.updatePromotion(u(c), c.input) },
    'schemes.list': { access: 'user', run: () => s().promotions.listSchemes() },
    'schemes.get': { access: 'admin', run: ({ input }) => s().promotions.getScheme(num(input?.id)) },
    'schemes.create': { access: 'admin', run: (c) => s().promotions.createScheme(u(c), c.input) },
    'schemes.update': { access: 'admin', run: (c) => s().promotions.updateScheme(u(c), c.input) },
    'schemes.draw': { access: 'admin', run: (c) => s().promotions.draw(u(c), c.input) },
    'customers.list': { access: 'admin', run: (c) => s().promotions.customers(u(c), c.input ?? {}) },
    // Cashiers may look up a returning customer by phone to pre-fill the name at checkout.
    'customers.lookup': { access: 'user', run: ({ input }) => s().promotions.lookupCustomer(String(input?.phone ?? '')) },

    'scanner.status': { access: 'user', run: () => scannerStatus() },
    'scanner.startPairing': {
      access: 'user',
      run: (c) => {
        if (!state.scanner?.running) throw new AppError('CONFLICT', 'Turn on the phone scanner in Settings → Barcode scanners first');
        state.scanner.startPairing();
        s().audit.log({ action: 'scanner.pairing_started', entityType: 'system', userId: u(c).id });
        return scannerStatus();
      },
    },
    'scanner.unpair': {
      access: 'user',
      run: (c) => {
        state.scanner?.unpair(String(c.input?.deviceId ?? ''));
        s().audit.log({ action: 'scanner.unpaired', entityType: 'system', userId: u(c).id, details: { deviceId: c.input?.deviceId } });
        return scannerStatus();
      },
    },

    'mobile.status': {
      access: 'admin',
      run: () => {
        const cfg = s().settings.get().mobile;
        const running = state.mobile?.running ?? false;
        return {
          enabled: cfg.enabled,
          running,
          port: cfg.port,
          urls: running ? lanUrls(cfg.port) : [],
          message: running ? 'Mobile dashboard is available on the shop network' : cfg.enabled ? 'Enabled but not running — check the port' : 'Disabled',
        };
      },
    },
  };

  const channels = new Set<string>(API_CHANNELS);

  // POS screens announce when they listen for phone scans, so the phone knows if a scan landed.
  const listening = new Set<number>();
  ipcMain.on('scanner:listen', (event, on: unknown) => {
    if (!event.senderFrame || !isTrustedUrl(event.senderFrame.url)) return;
    if (on === true) listening.add(event.sender.id);
    else listening.delete(event.sender.id);
    state.scanListeners = listening.size;
  });

  ipcMain.handle('srmart:invoke', async (event, channel: unknown, payload: unknown): Promise<ApiEnvelope<unknown>> => {
    const fail = (code: string, message: string, fields?: Record<string, string>): ApiEnvelope<unknown> => ({ ok: false, error: { code, message, fields } });
    if (!event.senderFrame || !isTrustedUrl(event.senderFrame.url)) return fail('FORBIDDEN', 'Untrusted sender');
    if (typeof channel !== 'string' || !channels.has(channel)) return fail('FORBIDDEN', 'Unknown channel');
    try {
      if (payload != null && JSON.stringify(payload).length > MAX_PAYLOAD_BYTES) return fail('VALIDATION', 'Request is too large');
    } catch {
      return fail('VALIDATION', 'Request is not serialisable');
    }
    const key = channel as ApiChannel;
    const handler = handlers[key] as Handler<ApiChannel>;
    // Refresh the user from the database on every call: disabled accounts lose access immediately.
    const uid = sessions.get(event.sender.id);
    const user = uid ? s().auth.refresh(uid) : null;
    if (uid && !user) sessions.delete(event.sender.id);
    try {
      if (handler.access !== 'public') {
        if (!user) throw new AppError('UNAUTHENTICATED', 'Please sign in');
        if (user.mustChangePassword && !ALLOWED_WHEN_PASSWORD_CHANGE_REQUIRED.has(key)) throw new AppError('FORBIDDEN', 'Change your password to continue');
        if (handler.access !== 'user') requireRole(user, handler.access);
      }
      const data = await handler.run({ user, input: (payload ?? undefined) as never, event });
      return { ok: true, data };
    } catch (err) {
      const e = toAppError(err);
      if (e.code === 'INTERNAL' || e.code === 'DATABASE') log.error(`${channel}: ${(err as Error)?.stack ?? String(err)}`);
      return fail(e.code, e.message, e.fields);
    }
  });
}
