import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import type { MobileSummary, SessionUser } from '@srmart/shared';
import { salesQuerySchema, toLocalISODate } from '@srmart/shared';
import { toAppError } from '../errors';
import type { Services } from '../services';

/**
 * Read-only admin API + static host for the mobile PWA, served on the shop LAN.
 * - Disabled by default; an administrator enables it in Settings.
 * - Admin accounts only; bearer tokens live in memory and expire after 12 hours.
 * - No endpoint can change data. Checkout never depends on this server.
 * - HTTPS with an offline local certificate; no plaintext authentication endpoint.
 */
export interface MobileServerOptions {
  services: () => Services;
  staticDir: string | null;
  port: number;
  host?: string;
  tls: { key: string; cert: string };
}

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export function lanUrls(port: number): string[] {
  const urls: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) if (ni.family === 'IPv4' && !ni.internal) urls.push(`http://${ni.address}:${port}`);
  }
  return urls;
}

export class MobileServer {
  private server: http.Server | null = null;
  private tokens = new Map<string, { user: SessionUser; expires: number; credentialHash: string }>();
  private attempts = new Map<string, { n: number; until: number }>();

  constructor(private opts: MobileServerOptions) {}

  get running() {
    return !!this.server?.listening;
  }

  get port() {
    return this.opts.port;
  }

  start(): Promise<void> {
    if (this.server) return Promise.resolve();
    const server = https.createServer(this.opts.tls, (req, res) => {
      this.handle(req, res).catch((err) => this.json(res, 500, { error: toAppError(err).message }));
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

  revokeAll() {
    this.tokens.clear();
  }

  stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    this.tokens.clear();
    return new Promise((resolve) => (s ? s.close(() => resolve()) : resolve()));
  }

  private json(res: http.ServerResponse, status: number, body: unknown) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify(body));
  }

  private async body(req: http.IncomingMessage): Promise<unknown> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > 10_000) throw new Error('Body too large');
      chunks.push(c as Buffer);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      return {};
    }
  }

  private auth(req: http.IncomingMessage): SessionUser | null {
    const h = req.headers.authorization ?? '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    const t = this.tokens.get(token);
    if (!t) return null;
    if (t.expires < Date.now()) {
      this.tokens.delete(token);
      return null;
    }
    // Re-check that the account is still an active admin.
    const fresh = this.opts.services().auth.refresh(t.user.id);
    const account = this.opts.services().users.repo.byId(t.user.id);
    if (!fresh || fresh.role !== 'admin' || fresh.mustChangePassword || account?.passwordHash !== t.credentialHash) {
      this.tokens.delete(token);
      return null;
    }
    return fresh;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = url.pathname;
    if (!p.startsWith('/api/')) return this.serveStatic(p, res);
    const svc = this.opts.services();
    const ip = req.socket.remoteAddress ?? 'unknown';

    if (p === '/api/health' && req.method === 'GET') return this.json(res, 200, { ok: true, app: 'Nayaro POS', readOnly: true });

    if (p === '/api/login' && req.method === 'POST') {
      const a = this.attempts.get(ip);
      if (a && a.until > Date.now()) return this.json(res, 429, { error: 'Too many attempts. Wait a minute and try again.' });
      try {
        const body = await this.body(req);
        const user = svc.auth.login(body);
        if (user.role !== 'admin') return this.json(res, 403, { error: 'Only administrator accounts can use the mobile dashboard' });
        if (user.mustChangePassword) return this.json(res, 403, { error: 'Change your password in the desktop app before using the mobile dashboard' });
        const token = crypto.randomBytes(32).toString('base64url');
        this.tokens.set(token, { user, expires: Date.now() + TOKEN_TTL_MS, credentialHash: svc.users.repo.byId(user.id)!.passwordHash });
        this.attempts.delete(ip);
        return this.json(res, 200, { token, user, expiresInSeconds: TOKEN_TTL_MS / 1000 });
      } catch (err) {
        const rec = this.attempts.get(ip) ?? { n: 0, until: 0 };
        rec.n += 1;
        if (rec.n >= 5) Object.assign(rec, { n: 0, until: Date.now() + 60_000 });
        this.attempts.set(ip, rec);
        return this.json(res, 401, { error: toAppError(err).message });
      }
    }

    if (p === '/api/logout' && req.method === 'POST') {
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      this.tokens.delete(token);
      return this.json(res, 200, { ok: true });
    }

    if (req.method !== 'GET') return this.json(res, 405, { error: 'This API is read-only' });
    const user = this.auth(req);
    if (!user) return this.json(res, 401, { error: 'Please sign in again' });

    try {
      if (p === '/api/summary') {
        const d = svc.reports.dashboard();
        const body: MobileSummary = {
          storeName: svc.settings.get().store.name,
          dataMode: d.dataMode,
          generatedAt: new Date().toISOString(),
          fiscal: d.fiscal,
          today: d.today,
          fiscalYearToDate: d.fiscalYearToDate,
          last7Days: d.last7Days,
          lowStock: svc.inventory.lowStock().slice(0, 50).map((x) => ({ id: x.id, sku: x.sku, name: x.name, qtyOnHand: x.qtyOnHand, minStock: x.minStock, unit: x.unit })),
          recent: d.recent,
        };
        return this.json(res, 200, body);
      }
      if (p === '/api/sales') {
        const date = url.searchParams.get('date') ?? toLocalISODate(new Date());
        const q = salesQuerySchema.parse({ from: date, to: date, page: Number(url.searchParams.get('page') ?? 1), pageSize: 50 });
        return this.json(res, 200, svc.sales.list(q));
      }
      const saleMatch = /^\/api\/sales\/(\d+)$/.exec(p);
      if (saleMatch) return this.json(res, 200, svc.sales.get(Number(saleMatch[1])));
      if (p === '/api/reports/sales') {
        return this.json(res, 200, svc.reports.salesReport({ from: url.searchParams.get('from'), to: url.searchParams.get('to'), groupBy: url.searchParams.get('groupBy') ?? 'day' }));
      }
      if (p === '/api/fiscal-years') return this.json(res, 200, svc.fiscal.list());
      if (p === '/api/stock-valuation') return this.json(res, 200, svc.reports.stockValuation());
      return this.json(res, 404, { error: 'Not found' });
    } catch (err) {
      const e = toAppError(err);
      return this.json(res, e.code === 'NOT_FOUND' ? 404 : e.code === 'VALIDATION' ? 400 : 500, { error: e.message });
    }
  }

  private serveStatic(pathname: string, res: http.ServerResponse) {
    const root = this.opts.staticDir;
    if (!root || !fs.existsSync(root)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Mobile app is not built. Run: npm run build -w @srmart/mobile');
    }
    const safe = path.normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
    let file = path.resolve(root, safe || 'index.html');
    if (file !== path.resolve(root) && !file.startsWith(path.resolve(root) + path.sep)) {
      res.writeHead(403);
      return res.end();
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': file.endsWith('index.html') || file.endsWith('sw.js') ? 'no-cache' : 'public, max-age=3600',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
    });
    fs.createReadStream(file).pipe(res);
  }
}
