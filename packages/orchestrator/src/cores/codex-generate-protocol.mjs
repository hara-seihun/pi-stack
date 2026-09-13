import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const packagePath = fileURLToPath(import.meta.resolve('@openai/codex/package.json'));
const binary = join(dirname(packagePath), 'bin', 'codex.js');
const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const runtime = JSON.parse(readFileSync(new URL('../../../runtime/package.json', import.meta.url), 'utf8'));
const pinned = manifest.dependencies['@openai/codex'];
if (runtime.dependencies['@openai/codex'] !== pinned) throw new Error('Runtime and Orchestrator must pin the same Codex version');
const version = execFileSync(process.execPath, [binary, '--version'], { encoding: 'utf8' }).trim();
if (version !== `codex-cli ${pinned}`) throw new Error(`Expected codex-cli ${pinned}, got ${version}`);
const source = mkdtempSync(join(tmpdir(), 'codex-protocol-'));
const destination = join(dirname(fileURLToPath(import.meta.url)), 'codex-protocol');
const roots = ['ThreadItem', 'Thread', 'Model', 'ThreadStartResponse', 'ThreadSettings', 'UserInput', 'SkillsListResponse', 'ThreadTokenUsage'];
const seen = new Set();
try {
  execFileSync(process.execPath, [binary, 'app-server', 'generate-ts', '--experimental', '--out', source]);
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
