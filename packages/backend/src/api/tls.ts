import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generate } from 'selfsigned';

const RENEW_AFTER_MS = 300 * 86_400_000;

function lanIps(): string[] {
  const ips: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) for (const ni of list ?? []) if (ni.family === 'IPv4' && !ni.internal) ips.push(ni.address);
  return ips;
}

/**
 * Self-signed certificate for the phone-scanner HTTPS server, generated offline and reused so the
 * phone only has to accept the warning once. Regenerated after ~300 days or if files are missing.
 */
export async function ensureCertificate(dir: string): Promise<{ key: string; cert: string; fingerprint: string }> {
  const keyFile = path.join(dir, 'scanner-key.pem');
  const certFile = path.join(dir, 'scanner-cert.pem');
  const metaFile = path.join(dir, 'scanner-cert.json');
  try {
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as { createdAt: string; fingerprint: string };
    if (Date.now() - new Date(meta.createdAt).getTime() < RENEW_AFTER_MS) {
      return { key: fs.readFileSync(keyFile, 'utf8'), cert: fs.readFileSync(certFile, 'utf8'), fingerprint: meta.fingerprint };
    }
  } catch {
    /* generate below */
  }
  fs.mkdirSync(dir, { recursive: true });
  const altNames = [{ type: 2 as const, value: 'localhost' }, { type: 7 as const, ip: '127.0.0.1' }, ...lanIps().map((ip) => ({ type: 7 as const, ip }))];
  const pems = await generate([{ name: 'commonName', value: 'Nayaro POS (local scanner)' }, { name: 'organizationName', value: 'Nayaro Tech' }], {
    keySize: 2048,
    algorithm: 'sha256',
    notAfterDate: new Date(Date.now() + 398 * 86_400_000),
    extensions: [{ name: 'subjectAltName', altNames }],
  });
  fs.writeFileSync(keyFile, pems.private, { mode: 0o600 });
  fs.writeFileSync(certFile, pems.cert);
  fs.writeFileSync(metaFile, JSON.stringify({ createdAt: new Date().toISOString(), fingerprint: pems.fingerprint }));
  return { key: pems.private, cert: pems.cert, fingerprint: pems.fingerprint };
}
