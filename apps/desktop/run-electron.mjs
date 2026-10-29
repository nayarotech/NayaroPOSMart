// Launches Electron with a clean environment. Some shells (e.g. VS Code terminals/extensions)
// export ELECTRON_RUN_AS_NODE=1, which would make Electron behave like plain Node.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const electron = require('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const here = path.dirname(fileURLToPath(import.meta.url));
const child = spawn(electron, [here, ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
