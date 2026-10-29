import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import type { ScannerDevice } from '@srmart/shared';
import { barcodeValueSchema } from '@srmart/shared';
import bwipjs from 'bwip-js';

/**
 * Turns a phone into a barcode scanner over the shop Wi-Fi — no internet, no app install.
 *
 * - HTTPS is required because phone browsers only allow camera access on secure pages. The
 *   desktop app generates a self-signed certificate offline; the phone shows a one-time warning.
 * - Pairing: the POS shows a QR code containing a random, single-use token that expires in
 *   5 minutes. The phone exchanges it for a device token (kept in memory; re-pair after restart).
 * - A paired phone can ONLY submit scanned codes. It cannot read sales, prices or settings beyond
 *   the product name/price shown as scan feedback, and cannot change anything else.
 */
export interface ScanResult {
  ok: boolean;
  message: string;
  product?: { name: string; pricePaisa: number } | null;
  delivered: boolean;
}

export interface ScannerServerOptions {
  port: number;
  host?: string;
  tls: { key: string; cert: string };
  /** Built mobile app folder containing scanner.html and assets/. */
  staticDir: string | null;
  onScan: (code: string, device: { id: string; name: string }) => ScanResult;
  storeName: () => string;
}

const PAIRING_TTL_MS = 5 * 60 * 1000;
const MAX_DEVICES = 5;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

interface Device extends ScannerDevice {
  token: string;
  window: number[];
}

export function qrSvg(text: string): string {
  return bwipjs.toSVG({ bcid: 'qrcode', text, scale: 4, paddingwidth: 2, paddingheight: 2 });
}

export class ScannerServer {
  private server: https.Server | null = null;
  private pairing: { token: string; expires: number } | null = null;
  private devices = new Map<string, Device>();
  private failedPairs = new Map<string, { n: number; until: number }>();

  constructor(private opts: ScannerServerOptions) {}

  get running() {
    return !!this.server?.listening;
  }
  get port() {
    return this.opts.port;
  }

  start(): Promise<void> {
    if (this.server) return Promise.resolve();
    const server = https.createServer({ key: this.opts.tls.key, cert: this.opts.tls.cert }, (req, res) => {
      this.handle(req, res).catch(() => this.json(res, 500, { error: 'Internal error' }));
    });
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once('error', (e) => {
        this.server = null;
        reject(e);
      });
      server.listen(this.opts.port, this.opts.host ?? '0.0.0.0', () => resolve());
    });
  }

  stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    this.pairing = null;
    this.devices.clear();
    return new Promise((resolve) => (s ? s.close(() => resolve()) : resolve()));
  }

  /** New single-use pairing token (replaces any previous one). */
  startPairing(): { token: string; expiresAt: string } {
    const token = crypto.randomBytes(18).toString('base64url');
    this.pairing = { token, expires: Date.now() + PAIRING_TTL_MS };
    return { token, expiresAt: new Date(this.pairing.expires).toISOString() };
  }

  pairingInfo(): { token: string; expiresAt: string } | null {
    if (!this.pairing || this.pairing.expires < Date.now()) return null;
    return { token: this.pairing.token, expiresAt: new Date(this.pairing.expires).toISOString() };
  }

  listDevices(): ScannerDevice[] {
    return [...this.devices.values()].map(({ id, name, pairedAt, lastSeenAt, scans }) => ({ id, name, pairedAt, lastSeenAt, scans }));
  }

  unpair(deviceId: string) {
    for (const [t, d] of this.devices) if (d.id === deviceId) this.devices.delete(t);
  }

  private json(res: import('node:http').ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(body));
  }

  private async body(req: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > 4_000) throw new Error('too large');
      chunks.push(c as Buffer);
    }
    try {
      const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  private device(req: import('node:http').IncomingMessage): Device | null {
    const h = req.headers.authorization ?? '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    return token ? (this.devices.get(token) ?? null) : null;
  }

  private async handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) {
    const url = new URL(req.url ?? '/', 'https://localhost');
    const p = url.pathname;
    const ip = req.socket.remoteAddress ?? '?';

    if (p === '/api/pair' && req.method === 'POST') {
      const f = this.failedPairs.get(ip);
      if (f && f.until > Date.now()) return this.json(res, 429, { error: 'Too many attempts. Wait a minute.' });
      const b = await this.body(req);
      const given = String(b.pairToken ?? '');
      const valid =
        !!this.pairing && this.pairing.expires > Date.now() && given.length === this.pairing.token.length &&
        crypto.timingSafeEqual(Buffer.from(given), Buffer.from(this.pairing.token));
      if (!valid) {
        const rec = this.failedPairs.get(ip) ?? { n: 0, until: 0 };
        rec.n += 1;
        if (rec.n >= 5) Object.assign(rec, { n: 0, until: Date.now() + 60_000 });
        this.failedPairs.set(ip, rec);
        return this.json(res, 401, { error: 'This pairing code is invalid or expired. Show a new QR code on the POS.' });
      }
      if (this.devices.size >= MAX_DEVICES) return this.json(res, 409, { error: `At most ${MAX_DEVICES} phones can be paired. Unpair one on the POS first.` });
      this.pairing = null; // single use
      const token = crypto.randomBytes(32).toString('base64url');
      const now = new Date().toISOString();
      const name = String(b.deviceName ?? 'Phone').replace(/[^\w .\-()]/g, '').slice(0, 40) || 'Phone';
      const dev: Device = { id: crypto.randomUUID(), name, pairedAt: now, lastSeenAt: now, scans: 0, token, window: [] };
      this.devices.set(token, dev);
      return this.json(res, 200, { deviceToken: token, deviceId: dev.id, storeName: this.opts.storeName() });
    }

    if (p === '/api/scan' && req.method === 'POST') {
      const dev = this.device(req);
      if (!dev) return this.json(res, 401, { error: 'Not paired. Scan the pairing QR code on the POS again.' });
      const now = Date.now();
      dev.window = dev.window.filter((t) => now - t < 1000);
      if (dev.window.length >= 10) return this.json(res, 429, { error: 'Scanning too fast' });
      dev.window.push(now);
      const b = await this.body(req);
      const parsed = barcodeValueSchema.safeParse(b.code);
      if (!parsed.success) return this.json(res, 400, { error: parsed.error.issues[0]?.message ?? 'Invalid barcode' });
      dev.scans += 1;
      dev.lastSeenAt = new Date().toISOString();
      return this.json(res, 200, this.opts.onScan(parsed.data, { id: dev.id, name: dev.name }));
    }

    if (p === '/api/ping' && req.method === 'GET') {
      const dev = this.device(req);
      if (!dev) return this.json(res, 401, { error: 'Not paired' });
      dev.lastSeenAt = new Date().toISOString();
      return this.json(res, 200, { ok: true, storeName: this.opts.storeName(), device: dev.name });
    }

    if (p.startsWith('/api/')) return this.json(res, 404, { error: 'Not found' });
    return this.serveStatic(p, res);
  }

  /** Serves only the scanner page and its assets — never the admin dashboard. */
  private serveStatic(pathname: string, res: import('node:http').ServerResponse) {
    const root = this.opts.staticDir;
    const rel = pathname === '/' ? 'scanner.html' : path.posix.normalize(decodeURIComponent(pathname)).replace(/^\/+/, '');
    const allowed = rel === 'scanner.html' || rel === 'icon.svg' || /^assets\/[\w.-]+\.(js|css)$/.test(rel);
    const file = root ? path.resolve(root, rel) : '';
    if (!root || !allowed || !file.startsWith(path.resolve(root)) || !fs.existsSync(file)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end(root ? 'Not found' : 'Scanner page not built. Run: npm run build');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': rel === 'scanner.html' ? 'no-cache' : 'public, max-age=3600',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'",
      'Permissions-Policy': 'camera=(self)',
    });
    fs.createReadStream(file).pipe(res);
  }
}
