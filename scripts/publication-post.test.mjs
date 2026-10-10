import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { rollForwardHosts, runHostLane, readHostLane } from '../deploy/publication-hosts.mjs';
import { publicationConfig } from './publication-fixture.mjs';

const publication = new URL('../deploy/publication', import.meta.url).href;
function fixture(t, hostId) {
  const root = mkdtempSync(join(tmpdir(), 'publication-post-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'integrations', 'a'.repeat(40));
  const bin = join(root, 'bin');
  const alerts = join(root, 'alerts');
  for (const directory of [source, bin, alerts, join(root, 'requests')]) mkdirSync(directory, { recursive: true });
  for (const [command, code] of [['bash', 9], ['npm', 12], ['ssh', 9]]) writeFileSync(join(bin, command),
    `#!/bin/sh\nprintf '%s %s\\n' '${command}' "$PWD" >> "$COMMAND_LOG"\nexit ${code}\n`, { mode: 0o700 });
  const request = { requestId: 'PUB-0123456789abcdef01234567', sourceSha: 'a'.repeat(40), integrationSha: 'a'.repeat(40),
    status: 'published', step: 'complete', attempt: 1, sourceSelection: { status: 'pinned' },
    checks: { status: 'deferred', phase: 'post-serving', androidPlan: { kind: 'native', identity: { revision: 'a'.repeat(40) } } },
    hosts: {}, failures: [], publishedAt: new Date().toISOString() };
  const lanes = join(root, 'host-lanes');
  rollForwardHosts(request, [{ id: hostId }], { laneRoot: lanes, active: () => false, save: () => {}, launch: (_target, input) => {
    runHostLane(input, { bind: () => {}, recover: () => {}, deliver: () => ({ status: 'passed', integrationSha: request.integrationSha }) });
    return { ok: true };
  } });
  const lane = readHostLane(lanes, request.requestId, request.integrationSha, hostId);
  const requestPath = join(root, 'requests', `${request.requestId}.json`);
  writeFileSync(requestPath, JSON.stringify(request));
  const before = readFileSync(requestPath);
  const receiptPath = join(root, 'post-serving', request.requestId, request.integrationSha, `${hostId}.json`);
  const commandLog = join(root, 'commands.log');
  function run() {
    return spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { executePostServing } from ${JSON.stringify(publication)}; executePostServing(${JSON.stringify(lane.inputPath)});`], {
      encoding: 'utf8', timeout: 5000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, COMMAND_LOG: commandLog,
        PI_STACK_PUBLICATION_CONFIG: publicationConfig(root, source),
        PI_STACK_PUBLICATION_STATE: root, PI_STACK_PUBLICATION_ALERT_INBOX: alerts },
    });
  }
  return { root, hostId, request, requestPath, before, receiptPath, commandLog, run, lane, lanes, alerts };
}

for (const hostId of ['gmktec', 'converge']) test(`${hostId} post-serving failure preserves source request and passed host custody`, t => {
  const f = fixture(t, hostId);
  const journalBefore = readFileSync(join(f.lanes, f.request.requestId, f.request.integrationSha, hostId, 'journal.json'));
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(readFileSync(f.receiptPath, 'utf8'));
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.integrationSha, f.request.integrationSha);
  assert.equal(receipt.hostId, hostId);
  assert.ok(receipt.failures.length);
  assert.deepEqual(readFileSync(f.requestPath), f.before);
  assert.deepEqual(readFileSync(join(f.lanes, f.request.requestId, f.request.integrationSha, hostId, 'journal.json')), journalBefore);
  const commands = readFileSync(f.commandLog, 'utf8');
  if (hostId === 'gmktec') {
    assert.equal(receipt.results.checks.exitCode, 9);
    assert.equal(receipt.results.androidTests.exitCode, 12);
    assert.ok(commands.includes(`bash ${join(f.root, 'integrations', f.request.integrationSha)}`));
    assert.ok(commands.includes(`npm ${join(f.root, 'integrations', f.request.integrationSha)}`));
  } else {
    assert.equal(receipt.results.checks, undefined);
    assert.equal(receipt.results.androidTests, undefined);
    assert.doesNotMatch(commands, /npm/);
  }
  assert.match(readFileSync(join(f.alerts, `pi-stack-post-${f.request.requestId}-${hostId}.md`), 'utf8'), /Serving selection is unchanged/);
  const postBefore = readFileSync(f.receiptPath);
  assert.equal(f.run().status, 0);
  assert.deepEqual(readFileSync(f.receiptPath), postBefore);
  assert.equal(readFileSync(f.commandLog, 'utf8'), commands);
});

test('post-serving work refuses a host that has not accepted source', t => {
  const f = fixture(t, 'gmktec');
  const journalPath = join(f.lanes, f.request.requestId, f.request.integrationSha, 'gmktec', 'journal.json');
  const lane = JSON.parse(readFileSync(journalPath, 'utf8'));
  lane.state = 'failed'; lane.outcome = { status: 'failed', failure: { message: 'start failed' } };
  writeFileSync(journalPath, JSON.stringify(lane));
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires this host serving receipt/);
  assert.deepEqual(readFileSync(f.requestPath), f.before);
});
