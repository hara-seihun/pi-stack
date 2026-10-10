import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

execFileSync(process.execPath, [fileURLToPath(new URL('../../scripts/workspace-closure.mjs', import.meta.url)), 'build'], { stdio: 'inherit' });
