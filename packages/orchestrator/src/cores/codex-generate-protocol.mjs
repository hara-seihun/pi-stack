import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const version = execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim();
if (version !== 'codex-cli 0.146.0') throw new Error(`Expected codex-cli 0.146.0, got ${version}`);
const source = mkdtempSync(join(tmpdir(), 'codex-protocol-'));
const destination = join(dirname(fileURLToPath(import.meta.url)), 'codex-protocol');
const roots = ['ThreadItem', 'Thread', 'Model', 'ThreadStartResponse', 'ThreadSettings', 'UserInput', 'SkillsListResponse', 'ThreadTokenUsage'];
const seen = new Set();
try {
  execFileSync('codex', ['app-server', 'generate-ts', '--experimental', '--out', source]);
  rmSync(destination, { recursive: true, force: true });
  const copy = file => {
    if (seen.has(file)) return;
    seen.add(file);
    const path = join(source, file);
    const text = readFileSync(path, 'utf8');
    for (const match of text.matchAll(/from "([^"]+)"/g)) copy(relative(source, resolve(dirname(path), `${match[1]}.ts`)));
    mkdirSync(dirname(join(destination, file)), { recursive: true });
    writeFileSync(join(destination, file), text.replace(/from "([^"]+)"/g, 'from "$1.js"'));
  };
  for (const root of roots) copy(`v2/${root}.ts`);
} finally { rmSync(source, { recursive: true, force: true }); }
