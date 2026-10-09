import { readFileSync, statSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BRIDGE_PROTOCOL } from './native-history-bridge.mjs';

export function ownerKeyCredential(fragment, user) {
  let key;
  for (const raw of fragment.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('LoadCredential=')) continue;
    const value = line.slice('LoadCredential='.length);
    if (value === '') { key = undefined; continue; }
    if (value.startsWith('key:')) key = value.replaceAll('%i', user);
  }
  if (key !== `key:/run/pi-remote-keys/${user}`) throw new Error('Existing owner key credential declaration is unavailable');
  return key;
}

export function recoveryInvocation({ item, root, legacyRemote, identity }, inspect = path => JSON.parse(readFileSync(path, 'utf8')), credentials = unit => {
  const result = spawnSync('systemctl', ['cat', '--no-pager', unit], { encoding: 'utf8', timeout: 3000 });
  if (result.status !== 0) throw new Error('Owner credential declaration is unavailable');
  const match = /^pi-remote@([a-z_][a-z0-9_-]{0,31})\.service$/.exec(unit);
  if (!match) throw new Error('Invalid original Remote credential owner');
  return ownerKeyCredential(result.stdout, match[1]);
}) {
  if (!['remote', 'fleet', 'rooms'].includes(item.mode) || !/^[a-z_][a-z0-9_-]{0,31}$/.test(item.user)
    || !Number.isSafeInteger(item.uid) || item.uid < 0 || !/^[0-9a-f]{40}$/.test(identity.candidate)
    || !/^[0-9a-f]{40}$/.test(identity.legacySource)) throw new Error('Invalid closed owner recovery identity');
  const input = { uid: item.uid, unit: item.unit, mode: item.mode, dataDir: item.dataDir, ...identity, allowUnacquired: true,
    ...(item.mode === 'fleet' ? { ledgerPath: item.ledgerPath } : {}) };
  const args = ['--quiet', '--wait', '--pipe', '--collect', '--service-type=oneshot',
    `--unit=pi-history-recover-${item.user}-${identity.candidate.slice(0, 12)}-${process.pid}`,
    `--property=User=${item.user}`, '--property=PrivateMounts=yes', '--property=KillMode=control-group',
    '--property=TimeoutStartSec=20', '--property=TimeoutStopSec=3', '--property=UMask=0077'];
  const command = ['/usr/local/bin/node', join(root, 'deploy/native-history-owner-recovery.mjs'), '--owner-command', JSON.stringify(input)];
  if (item.mode === 'remote') {
    const configPath = `/var/lib/pi-remote/persons/${item.user}.json`, config = inspect(configPath);
    if (config.user !== item.user || config.environment?.PI_REMOTE_DATA !== item.dataDir) throw new Error('Original person recovery configuration changed');
    args.push(`--setenv=PI_REMOTE_CONFIG=${configPath}`);
    if (config.unlock !== undefined && config.unlock !== null) {
      const declared = credentials(item.unit);
      if (declared !== `key:/run/pi-remote-keys/${item.user}`) throw new Error('Existing owner credential declaration is unavailable');
      args.push(`--property=LoadCredential=${declared}`);
    }
    command.unshift(join(legacyRemote, 'server/pi-remote-launch'));
  }
  return { input, args: [...args, '--', ...command] };
}

export function recoverClosedOwner(options) {
  if (process.getuid() !== 0) throw new Error('Private owner recovery requires the host administrator');
  const { root, legacyRemote, identity } = options;
  if (realpathSync(legacyRemote) !== legacyRemote || readFileSync(join(legacyRemote, '.pi-stack-commit'), 'utf8').trim() !== identity.legacySource) throw new Error('Private recovery requires the selected immutable old source');
  for (const file of ['native-history-owner-recovery.mjs', 'native-history-closed-owner.mjs']) {
    const info = statSync(join(root, 'deploy', file));
    if (info.uid !== 0 || (info.mode & 0o022)) throw new Error('Private recovery source lacks administrator custody');
  }
  const invocation = recoveryInvocation(options);
  const result = spawnSync('systemd-run', invocation.args, { encoding: 'utf8', timeout: 25000, maxBuffer: 1024 * 1024 });
  const proof = result.stdout ? JSON.parse(result.stdout) : null;
  if (result.status !== 0 || proof?.ok !== true) throw new Error(`Private owner recovery failed: ${proof?.error?.code ?? result.error?.message ?? result.stderr?.trim() ?? 'missing proof'}`);
  const value = proof.value;
  if (value.protocol !== BRIDGE_PROTOCOL || value.uid !== invocation.input.uid || value.dataDir !== invocation.input.dataDir
    || value.candidate !== identity.candidate || value.legacySource !== identity.legacySource || value.phase !== 'restored' || value.ready !== true) throw new Error('Private owner recovery proof identity mismatch');
  return value;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let proof;
  try {
    if (process.argv[2] !== '--owner-command' || process.argv.length !== 4) throw new Error('Expected one owner recovery request');
    const { restoreClosedOwner } = await import('./native-history-closed-owner.mjs');
    proof = restoreClosedOwner(JSON.parse(process.argv[3]));
  } catch (error) { proof = { ok: false, error: { code: 'recovery-command', message: String(error) } }; }
  console.log(JSON.stringify(proof));
  // The original launcher repeats exit 75. Recovery failures must close instead.
  if (!proof.ok) process.exitCode = 78;
}
