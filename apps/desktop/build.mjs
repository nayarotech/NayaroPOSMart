// Bundles the Electron main + preload with esbuild and copies the built renderer and mobile PWA.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'dist');
fs.rmSync(out, { recursive: true, force: true });

const common = { bundle: true, platform: 'node', format: 'cjs', target: 'node22', sourcemap: true, conditions: ['node'], logLevel: 'warning' };
await build({ ...common, entryPoints: [path.join(here, 'src/main.ts')], outfile: path.join(out, 'main.cjs'), external: ['electron', 'better-sqlite3'] });
await build({ ...common, entryPoints: [path.join(here, 'src/preload.ts')], outfile: path.join(out, 'preload.cjs'), external: ['electron'] });

function copyDir(from, to, label) {
  if (!fs.existsSync(from)) {
    console.warn(`! ${label} not built yet (${path.relative(here, from)}). Run "npm run build" at the repo root.`);
    return;
  }
  fs.cpSync(from, to, { recursive: true });
}
copyDir(path.join(here, '../frontend/dist'), path.join(out, 'renderer'), 'frontend');
copyDir(path.join(here, '../mobile/dist'), path.join(out, 'mobile'), 'mobile app');
console.log('desktop build ->', path.relative(process.cwd(), out));
