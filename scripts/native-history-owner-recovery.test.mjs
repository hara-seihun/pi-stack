import test from 'node:test';
import assert from 'node:assert/strict';
import { recoveryInvocation, ownerKeyCredential } from '../deploy/native-history-owner-recovery.mjs';

const options = { item: { user: 'alice', uid: 1002, unit: 'pi-remote@alice.service', mode: 'remote', dataDir: '/home/alice/private/.pi-remote' },
  root: '/source', legacyRemote: '/old', identity: { candidate: 'a'.repeat(40), legacySource: 'b'.repeat(40) } };
const person = { user: 'alice', environment: { PI_REMOTE_DATA: options.item.dataDir }, unlock: { cipherDir: '/cipher', mountpoint: '/home/alice/private' } };
test('closed encrypted owner uses its declared credential and original launcher, waits, and never starts an application', () => {
  const result = recoveryInvocation(options, () => person, () => 'key:/run/pi-remote-keys/alice');
  assert.ok(result.args.includes('--wait')); assert.ok(result.args.includes('--pipe'));
  assert.ok(result.args.includes('--property=PrivateMounts=yes'));
  assert.ok(result.args.includes('--property=LoadCredential=key:/run/pi-remote-keys/alice'));
  assert.equal(result.args[result.args.indexOf('--') + 1], '/old/server/pi-remote-launch');
  assert.equal(result.input.allowUnacquired, true);
  assert.ok(!result.args.some(arg => arg.endsWith('/server/main.ts')));
  assert.throws(() => recoveryInvocation(options, () => person, () => 'key:/another-owner'), /credential/);
  assert.throws(() => recoveryInvocation(options, () => ({ ...person, user: 'bob' })), /configuration/);
});
test('owner credential resolution respects template identity and explicit reset', () => {
  assert.equal(ownerKeyCredential('LoadCredential=key:/run/pi-remote-keys/%i\n', 'alice'), 'key:/run/pi-remote-keys/alice');
  assert.throws(() => ownerKeyCredential('LoadCredential=key:/run/pi-remote-keys/%i\nLoadCredential=\n', 'alice'), /unavailable/);
  assert.throws(() => ownerKeyCredential('LoadCredential=key:/run/pi-remote-keys/bob\n', 'alice'), /unavailable/);
});
test('closed fleet uses its own UID and exact ledger without another person credential or launcher', () => {
  const result = recoveryInvocation({ ...options, item: { ...options.item, mode: 'fleet', unit: 'pi-orchestrator@alice.service', ledgerPath: options.item.dataDir + '/ledger.sqlite3' } }, () => assert.fail(), () => assert.fail());
  assert.equal(result.args[result.args.indexOf('--') + 1], '/usr/local/bin/node');
  assert.equal(result.input.ledgerPath, options.item.dataDir + '/ledger.sqlite3');
  assert.ok(!result.args.some(arg => arg.includes('LoadCredential')));
});
