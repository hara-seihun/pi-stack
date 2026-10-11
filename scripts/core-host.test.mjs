import assert from 'node:assert/strict';
import test from 'node:test';
import { gatewayBinding, nativeModelBinding, sessionWriterConfiguration, nativeStorageConfiguration, validateSessionWriterMetadata, writerParentPreparation } from '../deploy/core-host.mjs';

const config = {
  host: '127.0.0.1', port: 2470, root: { kind: 'disabled' },
  principals: [{ id: 'first', kind: 'person', person: 'first' }, { id: 'second', kind: 'person', person: 'second' }],
  scopes: [{ id: 'first-chat', principalId: 'first', custody: { uid: 1001 }, callbackGateway: { kind: 'remote-callback', peerUid: 1001 } }],
  gatewayTransport: { kind: 'unix', socketDir: '/run/pi-stack/gateways' },
  gatewayBindings: [{ purpose: 'core-ingress', gatewayId: 'first-remote', peerUid: 1001, principalId: 'first', scopeIds: ['first-chat'] }],
  broker: { freshListeners: [], retainedListeners: { kind: 'uid-bound', bindings: [{ principalId: 'first-models', port: 2871, uid: 1001, authorizedUids: [1001] }] }, configPaths: ['/private/original.json'] },
};
const binding = { version: 1, user: 'first', scopeId: 'first-chat', gatewayId: 'first-remote',
  nativeModel: { kind: 'configured', url: 'http://127.0.0.1:2871', principalId: 'first-models', uid: 1001 } };
const original = () => ({ listeners: [{ principal: 'first-models', port: 2871 }] });

test('writer fence selects exact owning UID or explicitly configured in-process Root UID', () => {
  const scope = { id: 'fleet:first', custody: { uid: 1001, gid: 1001 } };
  assert.deepEqual(sessionWriterConfiguration(config, scope).value, { directory: '/run/pi-stack/session-writers/1001', scope: 'fleet:first', uid: 1001, gid: 1001 });
  const root = { ...config, root: { kind: 'configured', consultationScopeId: scope.id, consultationOwners: [] } };
  assert.deepEqual(sessionWriterConfiguration(root, scope).value, { directory: '/run/pi-stack/session-writers/0', scope: 'fleet:first', uid: 0, gid: 0 });
  assert.equal(sessionWriterConfiguration(config, { ...scope, custody: { uid: 1001 } }).ok, false);
  assert.equal(nativeStorageConfiguration(config, scope).ok, false);
  assert.deepEqual(nativeStorageConfiguration(config, { ...scope, custody: { ...scope.custody, dataDir: '/private/first' } }).value, { directory: '/run/pi-stack/native-runner-locks/1001', scope: scope.id, uid: 1001, gid: 1001, dataDir: '/private/first' });
});

test('writer custody rejects a FUSE alias, replaced inode, wrong Unix owner and writable leaf', () => {
  const expected = { uid: 1001, gid: 1001 };
  const local = { uid: 1001, gid: 1001, mode: 0o40700, dev: 41, ino: 55, isDirectory: () => true, isSymbolicLink: () => false };
  const host = { dev: 41, ino: 55 };
  assert.equal(validateSessionWriterMetadata(expected, local, host, { type: 0x01021994 }).ok, true);
  for (const update of [{ uid: 0 }, { gid: 0 }, { mode: 0o40755 }, { isSymbolicLink: () => true }]) assert.equal(validateSessionWriterMetadata(expected, { ...local, ...update }, host, { type: 0x01021994 }).ok, false);
  assert.equal(validateSessionWriterMetadata(expected, local, { ...host, ino: 56 }, { type: 0x01021994 }).ok, false);
  for (const type of [0x65735546, 0xEF53]) assert.equal(validateSessionWriterMetadata(expected, local, host, { type }).ok, false);
});

test('only the exact protected host parent may be normalized without replacing fence inodes', () => {
  const local = { uid: 0, gid: 0, mode: 0o40700, dev: 28, ino: 55, isDirectory: () => true, isSymbolicLink: () => false };
  const host = { dev: 28, ino: 55 }, filesystem = { type: 0x01021994 };
  assert.deepEqual(writerParentPreparation('/run/pi-stack', local, host, filesystem).value, { normalize: true });
  assert.deepEqual(writerParentPreparation('/run/pi-stack', { ...local, mode: 0o40755 }, host, filesystem).value, { normalize: false });
  assert.equal(writerParentPreparation('/run/pi-stack/session-writers', local, host, filesystem).ok, false);
  for (const change of [{ uid: 1000 }, { gid: 1000 }, { mode: 0o40777 }, { isSymbolicLink: () => true }]) assert.equal(writerParentPreparation('/run/pi-stack', { ...local, ...change }, host, filesystem).ok, false);
  assert.equal(writerParentPreparation('/run/pi-stack', local, { ...host, ino: 56 }, filesystem).ok, false);
  assert.equal(writerParentPreparation('/run/pi-stack', local, host, { type: 0x65735546 }).ok, false);
});

test('person transport binds exact kernel peer, principal, scope and reverse callback', () => {
  const result = gatewayBinding(config, binding, 1001, true);
  assert.equal(result.ok, true);
  assert.equal(result.value.callbackSocket, '/run/pi-stack/gateways/remote-first-chat/callback.sock');
  assert.equal(result.value.principalId, 'first');
  for (const input of [{ ...binding, user: 'second' }, { ...binding, scopeId: 'other' }, { ...binding, gatewayId: 'other' }, { ...binding, user: '../first' }]) {
    assert.equal(gatewayBinding(config, input, 1001, true).ok, false);
  }
  assert.equal(gatewayBinding(config, binding, 0, true).ok, false);
  const noCallback = { ...config, scopes: [{ ...config.scopes[0], callbackGateway: { kind: 'none' } }] };
  assert.equal(gatewayBinding(noCallback, binding, 1001, true).ok, false);
  assert.equal(gatewayBinding(noCallback, binding, 1001, false).ok, true);
});

test('canonical colon gateway IDs preserve their exact declared scope without sanitizing', () => {
  const scopeId = 'remote:first', gatewayId = 'remote-remote:first';
  const declared = { ...config, scopes: [{ ...config.scopes[0], id: scopeId }],
    gatewayBindings: [{ ...config.gatewayBindings[0], gatewayId, scopeIds: [scopeId] }] };
  const input = { ...binding, scopeId, gatewayId };
  const result = gatewayBinding(declared, input, 1001, true);
  assert.equal(result.ok, true);
  assert.equal(result.value.gatewayId, gatewayId);
  assert.equal(result.value.callbackSocket, '/run/pi-stack/gateways/remote-remote:first/callback.sock');
  for (const changed of ['remote-remote_first', '../remote-remote:first', 'remote-remote:first/other']) {
    assert.equal(gatewayBinding(declared, { ...input, gatewayId: changed }, 1001, true).ok, false);
  }
});

test('native model origin selects exact original UID listener, never gateway URL or first listener', () => {
  assert.equal(nativeModelBinding(config, binding, 1001, original).ok, true);
  for (const change of [{ url: 'http://127.0.0.1:2470/v1/model-broker' }, { principalId: 'other' }, { uid: 0 }, { token: 'foreign' }]) {
    const input = { ...binding, nativeModel: { ...binding.nativeModel, ...change } };
    assert.equal(nativeModelBinding(config, input, 1001, original).ok, false);
  }
  assert.equal(nativeModelBinding(config, binding, 1002, original).ok, false);
  assert.equal(nativeModelBinding(config, binding, 1001, () => ({ listeners: [] })).ok, false);
});

test('explicit none preserves only the original direct-provider owner, never a default or foreign listener', () => {
  const direct = { ...config, broker: { ...config.broker, kind: 'configured', ownerPrincipal: 'first' }, scopes: [{ ...config.scopes[0], environment: {} }] };
  const input = { ...binding, nativeModel: { kind: 'none' } };
  const neverRead = () => { throw new Error('none must not select a listener'); };
  assert.deepEqual(nativeModelBinding(direct, input, 1001, neverRead), { ok: true, value: { kind: 'none' } });
  for (const nativeModel of [undefined, {}, { kind: 'none', url: 'http://127.0.0.1:2871' }, { kind: 'disabled' }]) assert.equal(nativeModelBinding(direct, { ...input, nativeModel }, 1001, original).ok, false);
  assert.equal(nativeModelBinding(direct, { ...input, modelBrokerUrl: binding.nativeModel.url }, 1001, original).ok, false);
  assert.equal(nativeModelBinding(direct, input, 1002, original).ok, false);
  assert.equal(nativeModelBinding({ ...direct, broker: { ...direct.broker, ownerPrincipal: 'second' } }, input, 1001, original).ok, false);
  assert.equal(nativeModelBinding({ ...direct, scopes: [{ ...direct.scopes[0], environment: { PI_MODEL_BROKER_URL: binding.nativeModel.url } }] }, input, 1001, original).ok, false);
  assert.equal(nativeModelBinding(config, input, 1001, original).ok, false);
  assert.equal(nativeModelBinding(direct, { ...binding, nativeModel: undefined, modelBrokerUrl: binding.nativeModel.url, modelBrokerPrincipalId: 'first-models', modelBrokerUid: 1001 }, 1001, original).ok, false);
});

test('root consultations require the actual in-process core UID without broadening ordinary native grants', () => {
  const root = { ...config, root: { kind: 'configured', consultationScopeId: 'first-chat', consultationOwners: [] } };
  assert.equal(nativeModelBinding(root, binding, 1001, original).ok, false);
  const admitted = { ...root, broker: { ...root.broker, retainedListeners: { kind: 'uid-bound', bindings: [{ ...config.broker.retainedListeners.bindings[0], authorizedUids: [0] }] } } };
  assert.equal(nativeModelBinding(admitted, binding, 1001, original).ok, true);
  assert.equal(nativeModelBinding({ ...admitted, root: config.root }, binding, 1001, original).ok, false);
});
