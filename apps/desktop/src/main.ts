import { app, BrowserWindow, dialog, Menu, session, shell } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AppState } from './appState';
import { registerIpc } from './ipc';
import { log } from './log';
import { PrinterService } from './printing';

const DEV_URL = process.env.SRMART_DEV_URL ?? null;
const SMOKE = process.argv.includes('--smoke-test');
const rendererIndex = path.join(__dirname, 'renderer', 'index.html');
const rendererBase = pathToFileURL(path.dirname(rendererIndex)).href;

let mainWindow: BrowserWindow | null = null;
const state = new AppState();

function isTrustedUrl(url: string) {
  if (DEV_URL && url.startsWith(DEV_URL)) return true;
  return url.startsWith(rendererBase);
}

// One counter = one instance. A second launch focuses the existing window instead of opening the DB twice.
if (!SMOKE && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: 'Nayaro POS',
    backgroundColor: '#f6f7f9',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  // Block navigation away from the app and pop-up windows.
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!isTrustedUrl(url)) e.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  if (DEV_URL) void mainWindow.loadURL(DEV_URL);
  else void mainWindow.loadFile(rendererIndex);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function smokeTest() {
  // Verifies the packaged runtime: native SQLite loads under Electron, migrations run, a backup verifies.
  try {
    state.open();
    const svc = state.services;
    const fy = svc.fiscal.current();
    const products = svc.products.list({}).total;
    const backup = state.backups.create('smoke-test');
    const verified = state.backups.testRestore(backup.file);
    process.stdout.write(`SMOKE OK electron=${process.versions.electron} sqlite=${(state.db.prepare('select sqlite_version() v').get() as { v: string }).v} fy=${fy.code} products=${products} backup=${verified.ok}\n`);
    state.close();
    app.exit(0);
  } catch (err) {
    process.stdout.write(`SMOKE FAILED ${(err as Error).stack}\n`);
    app.exit(1);
  }
}

app.whenReady().then(async () => {
  if (SMOKE) return smokeTest();
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  try {
    state.open();
  } catch (err) {
    log.error(`database open failed: ${(err as Error).stack}`);
    dialog.showErrorBox('Nayaro POS — database error', `The database could not be opened.\n\n${(err as Error).message}\n\nRestore the latest backup (see README → Backup and recovery).`);
    app.exit(1);
    return;
  }
  // Daily safety backup on start if the newest one is older than 24 h.
  const newest = state.backups.list()[0];
  if (!newest || Date.now() - new Date(newest.createdAt).getTime() > 86_400_000) state.autoBackup('auto-daily');

  const printers = new PrinterService(() => mainWindow);
  registerIpc(state, printers, isTrustedUrl);
  state.pushScan = (e) => mainWindow?.webContents.send('scanner:code', e);
  if (app.isPackaged) Menu.setApplicationMenu(null);
  createWindow();
  state.syncMobileServer().catch(() => undefined);
  state.syncScannerServer().catch((err) => log.error(`phone scanner failed to start: ${(err as Error).message}`));
});

let quitting = false;
app.on('before-quit', (e) => {
  if (quitting || SMOKE) return;
  quitting = true;
  e.preventDefault();
  (async () => {
    try {
      if (state.services?.settings.get().backup.autoBackupOnExit) state.autoBackup('auto-exit');
      await state.mobile?.stop();
      await state.scanner?.stop();
    } finally {
      state.close();
      app.exit(0);
    }
  })().catch(() => app.exit(0));
});

app.on('window-all-closed', () => app.quit());
app.on('activate', () => {
  if (!mainWindow && app.isReady()) createWindow();
});
