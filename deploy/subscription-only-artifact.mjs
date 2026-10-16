import { cpSync, readFileSync, writeFileSync, mkdirSync, existsSync, symlinkSync, renameSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

// Deploy a source-bound prebuilt component payload without a second source checkout.
const [payloadArg] = process.argv.slice(2);
if (!payloadArg || process.argv.length !== 3) throw Error('usage: node subscription-only-artifact.mjs PAYLOAD');
if (process.getuid() !== 0) throw Error('root required');
const payload = resolve(payloadArg), manifest = JSON.parse(readFileSync(join(payload, 'payload.json'), 'utf8'));
if (!/^[0-9a-f]{40}$/.test(manifest.source) || !/^[0-9a-f]{40}$/.test(manifest.base)) throw Error('Invalid source binding');
for (const entry of manifest.files) {
  if (entry.path.startsWith('/') || entry.path.split('/').includes('..')) throw Error('Invalid artifact path');
  if (createHash('sha256').update(readFileSync(join(payload, entry.path))).digest('hex') !== entry.sha256) throw Error('Artifact hash mismatch');
}
const base = realpathSync('/srv/pi/pi-orchestrator');
if (readFileSync(join(base, '.pi-stack-commit'), 'utf8').trim() !== manifest.base) throw Error('Legacy base changed');
const target = `/srv/pi/.pi-stack-releases/orchestrator/subscription-only-${manifest.source}`;
if (existsSync(target)) throw Error('Immutable target already exists; reconcile before another attempt');
const stage = `${target}.stage-${process.pid}`;
cpSync(base, stage, { recursive: true, verbatimSymlinks: true });
for (const entry of manifest.files) {
  mkdirSync(join(stage, entry.path, '..'), { recursive: true });
  cpSync(join(payload, entry.path), join(stage, entry.path));
}
writeFileSync(join(stage, 'subscription-only-binding.json'), JSON.stringify({ source: manifest.source, base }));
execFileSync(process.execPath, [join(stage, 'subscription-only-check.mjs'), stage], { stdio: 'inherit', timeout: 10000 });
renameSync(stage, target);
symlinkSync(target, '/srv/pi/pi-orchestrator.subscription-next');
renameSync('/srv/pi/pi-orchestrator.subscription-next', '/srv/pi/pi-orchestrator');
console.log(JSON.stringify({ ok: true, target, source: manifest.source, servicesRestarted: 0 }));
