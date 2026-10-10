import assert from 'node:assert/strict';
import test from 'node:test';
import { gatewayBinding, nativeModelBinding } from '../deploy/core-host.mjs';

const config = {
  host: '127.0.0.1', port: 2470, root: { kind: 'disabled' },
  principals: [{ id: 'first', kind: 'person', person: 'first' }, { id: 'second', kind: 'person', person: 'second' }],
  scopes: [{ id: 'first-chat', principalId: 'first', custody: { uid: 1001 }, callbackGateway: { kind: 'remote-callback', peerUid: 1001 } }],
  gatewayTransport: { kind: 'unix', socketDir: '/run/pi-stack/gateways' },
  gatewayBindings: [{ purpose: 'core-ingress', gatewayId: 'first-remote', peerUid: 1001, principalId: 'first', scopeIds: ['first-chat'] }],
  broker: { freshListeners: [], retainedListeners: { kind: 'uid-bound', bindings: [{ principalId: 'first-models', port: 2871, uid: 1001, authorizedUids: [1001] }] }, configPaths: ['/private/original.json'] },
};
const binding = { version: 1, user: 'first', scopeId: 'first-chat', gatewayId: 'first-remote',
  modelBrokerUrl: 'http://127.0.0.1:2871', modelBrokerPrincipalId: 'first-models', modelBrokerUid: 1001 };
const original = () => ({ listeners: [{ principal: 'first-models', port: 2871 }] });

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

test('native model origin selects exact original UID listener, never gateway URL or first listener', () => {
  assert.equal(nativeModelBinding(config, binding, 1001, original).ok, true);
  for (const input of [{ ...binding, modelBrokerUrl: 'http://127.0.0.1:2470/v1/model-broker' }, { ...binding, modelBrokerPrincipalId: 'other' }, { ...binding, modelBrokerUid: 0 }]) {
    assert.equal(nativeModelBinding(config, input, 1001, original).ok, false);
  }
  assert.equal(nativeModelBinding(config, binding, 1002, original).ok, false);
  assert.equal(nativeModelBinding(config, binding, 1001, () => ({ listeners: [] })).ok, false);
});

test('root consultations require the actual in-process core UID without broadening ordinary native grants', () => {
  const root = { ...config, root: { kind: 'configured', consultationScopeId: 'first-chat', consultationOwners: [] } };
  assert.equal(nativeModelBinding(root, binding, 1001, original).ok, false);
  const admitted = { ...root, broker: { ...root.broker, retainedListeners: { kind: 'uid-bound', bindings: [{ ...config.broker.retainedListeners.bindings[0], authorizedUids: [0] }] } } };
  assert.equal(nativeModelBinding(admitted, binding, 1001, original).ok, true);
  assert.equal(nativeModelBinding({ ...admitted, root: config.root }, binding, 1001, original).ok, false);
});
