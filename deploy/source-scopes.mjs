import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const runtime = ['package.json', 'package-lock.json', 'vendor/pi', 'packages/runtime', 'packages/orchestrator/src', 'packages/kenan-memory', 'packages/kenan-root', 'config/packages.json', 'deploy/runtime', 'deploy/lib', 'deploy/source-scopes.mjs', 'deploy/component-cache.mjs'];
const orchestrator = [...runtime, 'packages/orchestrator', 'scripts/build-workspace.mjs', 'deploy/orchestrator'];
const remote = [...orchestrator, 'apps/remote', 'deploy/remote', 'deploy/remote-resources.mjs', 'scripts/check-remote-imports.ts', 'deploy/one-kenan-activate', 'deploy/editor', 'deploy/smoke', 'deploy/meeting-census', 'deploy/release-checkout', 'docs/editor.md', 'docs/native-history-migration.md', 'scripts/migrate-native-history.mjs'];
export const componentScopes = { runtime, orchestrator, remote, tools: [...orchestrator, 'tools', 'config/tools.json', 'deploy/tools'] };
const sdk = ['package.json', 'package-lock.json', 'vendor/pi', 'deploy/runtime', 'packages/runtime/patch-claude-oauth.mjs', 'packages/runtime/extensions/claude-oauth/client.json', 'packages/runtime/patch-codex-sse.mjs', 'packages/runtime/patch-codex-service-recovery.mjs', 'packages/runtime/codex-service-recovery.js', 'packages/runtime/patch-anthropic-error-content.mjs', 'packages/runtime/patch-anthropic-tool-schema.mjs', 'packages/runtime/anthropic-tool-schema.js', 'packages/runtime/patch-anthropic-narration.mjs', 'packages/runtime/patch-compaction-errors.mjs', 'packages/runtime/patch-summary-recovery.mjs', 'packages/runtime/bounded-summary.js', 'packages/runtime/patch-bash-spill.mjs', 'packages/runtime/patch-bash-cancellation.mjs', 'packages/runtime/pi-shell-owner.mjs', 'packages/runtime/pi-shell-owner.py', 'packages/runtime/patch-session-durability.mjs', 'packages/runtime/patch-shared-custody.mjs', 'packages/runtime/patch-shared-rpc.mjs'];
const rootOwner = [...sdk, 'packages/kenan-root', 'packages/kenan-memory', 'packages/orchestrator/src', 'packages/orchestrator/package.json', 'scripts/build-workspace.mjs', 'deploy/systemd/pi-kenan-root.service', 'deploy/one-kenan-runtime'];
const memoryOwner = ['package.json', 'package-lock.json', 'packages/kenan-memory', 'packages/orchestrator/src/person-timezone.ts', 'packages/orchestrator/src/person-settings-contract.ts', 'apps/remote/server/room-audience.mjs', 'deploy/systemd/pi-kenan-memory.service', 'deploy/one-kenan-runtime'];
const roomsOwner = [...orchestrator, 'apps/remote/server', 'apps/remote/shared', 'apps/remote/package.json', 'apps/remote/meeting-runtime.json', 'apps/remote/data-contract.json', 'deploy/systemd/pi-rooms.service'];
export const ownerScopes = {
  remote: [...orchestrator, 'apps/remote/server', 'apps/remote/shared', 'apps/remote/meeting-runtime.json', 'apps/remote/data-contract.json', 'deploy/remote', 'deploy/remote-resources.mjs'],
  router: [...runtime, 'apps/remote/server', 'apps/remote/shared', 'apps/remote/package.json', 'deploy/systemd/pi-remote-router.service'],
  daemons: [...orchestrator, 'config/models.json', 'deploy/systemd/pi-orchestrator@.service'],
  brokers: [...orchestrator, 'apps/remote/server/model-broker', 'apps/remote/server/model-broker.ts', 'config/models.json'],
  voice: [...orchestrator, 'apps/remote/server', 'apps/remote/shared', 'deploy/voice', 'deploy/systemd/pi-stack-voice.service'],
  phone: [...orchestrator, 'apps/remote/server', 'apps/remote/shared', 'deploy/phone', 'deploy/systemd/pi-stack-phone.service'],
  root: rootOwner,
  memory: memoryOwner,
  rooms: roomsOwner,
  oneKenan: [...new Set([...rootOwner, ...memoryOwner, ...roomsOwner])],
};
export function sourceKeys(root, commit, scopes) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('source commit must be a full SHA');
  const tree = execFileSync('git', ['-C', root, 'ls-tree', '-rz', commit], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\0').filter(Boolean);
  return Object.fromEntries(Object.entries(scopes).map(([name, paths]) => {
    const hash = createHash('sha256').update('pi-stack-source-scope-v1\0');
    hash.update(JSON.stringify(paths));
    for (const entry of tree) {
      const path = entry.slice(entry.indexOf('\t') + 1);
      if (paths.some(scope => path === scope || path.startsWith(`${scope}/`)) || /^(apps|packages|tools)\/.*\/package\.json$/.test(path)) hash.update(entry).update('\0');
    }
    return [name, hash.digest('hex')];
  }));
}
