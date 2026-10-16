import { readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkBroker } from './subscription-only-check.mjs';

try {
  if (process.argv.length !== 2) throw Error('This installed guard accepts no arguments');
  const config = JSON.parse(readFileSync('/usr/local/lib/pi-subscription-only/host.json', 'utf8'));
  const checks = [];
  for (const item of config.bindings) {
    const bytes = readFileSync(item.path);
    if (createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw Error('Installed subscription source binding changed: ' + item.path);
  }
  if (config.broker.kind === 'local-service') {
    const pid = Number(execFileSync('systemctl', ['show', config.broker.service, '-p', 'MainPID', '--value'], { encoding: 'utf8', timeout: 3000 }).trim());
    if (!pid) throw Error('Broker service is not running');
    const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    if (!args.includes(join(config.broker.root, 'dist/cli.js')) || !args.includes(config.broker.config)) throw Error('Loaded broker command does not match installed source');
    const broker = JSON.parse(readFileSync(config.broker.config, 'utf8'));
    if (!broker.listeners.length || broker.listeners.some(x => x.models.some(m => !/^(openai-codex|anthropic)\//.test(m)))) throw Error('Non-subscription broker grant');
    const credentials = JSON.parse(readFileSync(broker.authPath, 'utf8'));
    const aliases = new Set(broker.listeners.flatMap(x => x.accounts));
    let oauth = 0, unset = 0, transfers = 0;
    for (const alias of aliases) {
      const value = credentials[alias];
      if (value === undefined) { unset++; continue; }
      if (String(value.type).startsWith('account-transfer')) { transfers++; continue; }
      if (value.type !== 'oauth' || typeof value.access !== 'string' || !value.access || typeof value.refresh !== 'string' || !value.refresh || !Number.isFinite(value.expires)) throw Error('Broker pool contains non-subscription credential metadata');
      oauth++;
    }
    checks.push({ ...(await checkBroker(config.broker.root)), loadedPid: pid, actualCredentialMetadata: { oauth, unset, transfers }, listeners: broker.listeners.length });
  } else if (config.broker.kind === 'separate-stack-owner') {
    checks.push({ component: 'shared-broker', scope: 'separate-stack-owner', owner: config.broker.owner });
  } else throw Error('Unknown host broker role');
  const legacy = realpathSync('/srv/pi/pi-orchestrator');
  if (legacy !== config.legacyRoot) throw Error('Legacy selected source changed');
  checks.push(await checkBroker(legacy));
  const runtime = realpathSync('/srv/pi/runtime/node_modules');
  const runtimeCheck = await import(pathToFileURL(config.runtimeGuard));
  const result = await runtimeCheck.checkRuntime(runtime);
  if (!result.ok) throw Error('Direct Pi runtime guard failed');
  checks.push(result);
  console.log(JSON.stringify({ ok: true, component: 'broker-legacy-host', checks, boundFiles: config.bindings.length, networkCalls: 0 }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, component: 'broker-legacy-host', code: error.code ?? 'subscription_guard_failed', message: error.message }));
  process.exitCode = 1;
}
