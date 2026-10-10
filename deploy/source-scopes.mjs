import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, posix } from 'node:path';

const runtime = ['package.json', 'package-lock.json', 'vendor/pi', 'packages/runtime', 'packages/orchestrator/src', 'packages/kenan-memory', 'packages/kenan-root', 'config/packages.json', 'deploy/runtime', 'deploy/lib', 'deploy/source-scopes.mjs', 'deploy/component-cache.mjs', 'scripts/workspace-closure.mjs'];
const orchestrator = [...runtime, 'packages/orchestrator', 'scripts/build-workspace.mjs', 'deploy/orchestrator', 'deploy/core-host.mjs', 'deploy/core-runtime', 'deploy/core-custody', 'deploy/core-person-activate', 'deploy/core-plan', 'deploy/core-drain', 'deploy/core-root-census', 'deploy/core-bindings', 'deploy/core-assemble', 'deploy/core-aux-plan', 'deploy/core-aux-run', 'deploy/core-image-handoff', 'deploy/core-capability-epoch.py', 'deploy/core-auxiliary.ts', 'deploy/core-broker-handoff.mjs', 'deploy/core-adopt', 'deploy/core_namespace.py', 'deploy/systemd/pi-stack-core.service', 'deploy/systemd/pi-stack-core-custody.service'];
const remote = [...orchestrator, 'apps/remote', 'deploy/remote', 'deploy/remote-resources.mjs', 'scripts/check-remote-imports.ts', 'deploy/editor', 'deploy/smoke', 'deploy/meeting-census', 'deploy/release-checkout', 'docs/editor.md', 'docs/native-history-migration.md', 'scripts/migrate-native-history.mjs'];
export const componentScopes = { runtime, orchestrator, remote, tools: [...orchestrator, 'tools', 'config/tools.json', 'deploy/tools'] };
const sdk = ['package.json', 'package-lock.json', 'vendor/pi', 'deploy/runtime', 'packages/runtime/patch-claude-oauth.mjs', 'packages/runtime/extensions/claude-oauth/client.json', 'packages/runtime/patch-codex-sse.mjs', 'packages/runtime/patch-codex-service-recovery.mjs', 'packages/runtime/codex-service-recovery.js', 'packages/runtime/patch-anthropic-error-content.mjs', 'packages/runtime/patch-anthropic-tool-schema.mjs', 'packages/runtime/anthropic-tool-schema.js', 'packages/runtime/patch-anthropic-narration.mjs', 'packages/runtime/patch-compaction-errors.mjs', 'packages/runtime/patch-summary-recovery.mjs', 'packages/runtime/bounded-summary.js', 'packages/runtime/patch-bash-spill.mjs', 'packages/runtime/patch-bash-cancellation.mjs', 'packages/runtime/pi-shell-owner.mjs', 'packages/runtime/pi-shell-owner.py', 'packages/runtime/pi-bash-worker.py', 'packages/runtime/patch-session-durability.mjs', 'packages/runtime/patch-shared-custody.mjs', 'packages/runtime/patch-shared-rpc.mjs'];
const roomsOwner = [...orchestrator, 'apps/remote/server', 'apps/remote/shared', 'apps/remote/package.json', 'apps/remote/meeting-runtime.json', 'apps/remote/data-contract.json', 'deploy/systemd/pi-rooms.service'];
export const ownerScopes = {
  remote: [...orchestrator, 'apps/remote/server', 'apps/remote/shared', 'apps/remote/meeting-runtime.json', 'apps/remote/data-contract.json', 'deploy/remote', 'deploy/remote-resources.mjs'],
  router: [...runtime, 'apps/remote/server', 'apps/remote/shared', 'apps/remote/package.json', 'deploy/systemd/pi-remote-router.service'],
  core: [...orchestrator, 'config/models.json', 'deploy/core-host.mjs', 'deploy/systemd/pi-stack-core.service'],
  voice: [...orchestrator, 'apps/remote/server', 'apps/remote/shared', 'deploy/voice', 'deploy/systemd/pi-stack-voice.service'],
  phone: [...orchestrator, 'apps/remote/server', 'apps/remote/shared', 'deploy/phone', 'deploy/systemd/pi-stack-phone.service'],
  rooms: roomsOwner,
  custody: ['apps/remote/server/one-kenan-access.ts', 'apps/remote/server/one-kenan-keys.ts', 'apps/remote/server/one-kenan-mounts.ts', 'deploy/one-kenan-runtime', 'deploy/systemd/pi-kenan-access.service', 'deploy/systemd/pi-kenan-custody.service'],
  oneKenan: [...new Set([...orchestrator, ...roomsOwner])],
};
function memoryImports(root, commit, entries) {
  const available = new Set(entries.map(entry => entry.slice(entry.indexOf('\t') + 1)));
  const pending = ['packages/kenan-memory/src/main.ts', 'apps/remote/server/room-audience.mjs'].filter(path => available.has(path));
  const visited = new Set();
  function resolveInput(base) {
    const extensionless = base.replace(/\.(?:js|mjs|cjs)$/, '');
    const path = [base, `${extensionless}.ts`, `${extensionless}.mts`, `${base}.ts`, `${base}.js`, `${base}.mjs`, `${base}/index.ts`, `${base}/index.js`].find(path => available.has(path));
    if (!path) throw new Error(`Memory import is absent from the source generation: ${base}`);
    return path;
  }
  while (pending.length) {
    const path = pending.pop();
    if (visited.has(path)) continue;
    visited.add(path);
    if (!/\.(?:ts|mts|js|mjs)$/.test(path)) continue;
    const source = execFileSync('git', ['-C', root, 'show', `${commit}:${path}`], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
    for (const match of source.matchAll(/\b(?:import|require)\s*\(\s*([^"'\s][^)]*)\)/g)) {
      if (path !== 'packages/kenan-memory/src/main.ts' || match[1].trim() !== 'roomModule') throw new Error(`Memory has an undeclared dynamic source import: ${path}`);
    }
    for (const match of source.matchAll(/\b(?:from\s*|import\s+|import\s*\(|require\s*\()\s*["']([^"']+)["']/g)) {
      const specifier = match[1];
      if (specifier.startsWith('.')) pending.push(resolveInput(posix.normalize(posix.join(dirname(path), specifier))));
      else if (specifier.startsWith('kenan-memory/')) pending.push(resolveInput(`packages/kenan-memory/src/${specifier.slice('kenan-memory/'.length)}`));
      else if (specifier.startsWith('pi-orchestrator/')) {
        const manifest = JSON.parse(execFileSync('git', ['-C', root, 'show', `${commit}:packages/orchestrator/package.json`], { encoding: 'utf8' }));
        const exported = manifest.exports?.[`./${specifier.slice('pi-orchestrator/'.length)}`];
        const targets = typeof exported === 'string' ? [exported] : Object.entries(exported ?? {}).filter(([condition]) => condition !== 'types').map(([, target]) => target);
        if (!targets.length || targets.some(target => typeof target !== 'string')) throw new Error(`Memory workspace import has no declared executable source: ${specifier}`);
        for (const target of targets) pending.push(resolveInput(posix.join('packages/orchestrator', target.replace(/^\.\/dist\//, './src/'))));
      }
    }
  }
  return [...visited].sort();
}
export function sourceKeys(root, commit, scopes) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('source commit must be a full SHA');
  const tree = execFileSync('git', ['-C', root, 'ls-tree', '-rz', commit], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\0').filter(Boolean);
  return Object.fromEntries(Object.entries(scopes).map(([name, declared]) => {
    const paths = (name === 'memory' || name === 'oneKenan') ? [...new Set([...declared, ...memoryImports(root, commit, tree)])].sort() : declared;
    const hash = createHash('sha256').update('pi-stack-source-scope-v1\0');
    hash.update(JSON.stringify(paths));
    for (const entry of tree) {
      const path = entry.slice(entry.indexOf('\t') + 1);
      if (paths.some(scope => path === scope || path.startsWith(`${scope}/`)) || /^(apps|packages|tools)\/.*\/package\.json$/.test(path)) hash.update(entry).update('\0');
    }
    return [name, hash.digest('hex')];
  }));
}
