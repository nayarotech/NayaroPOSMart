import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/** Minimal file logger. Never pass passwords, tokens or full payloads to it. */
function write(level: string, msg: string) {
  const line = `${new Date().toISOString()} [${level}] ${msg}\n`;
  if (level !== 'info' || !app.isPackaged) process.stdout.write(line);
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'main.log'), line);
  } catch {
    /* logging must never crash the app */
  }
}

export const log = {
  info: (m: string) => write('info', m),
  warn: (m: string) => write('warn', m),
  error: (m: string) => write('error', m),
};
