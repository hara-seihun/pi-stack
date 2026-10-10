import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { personBinding } from '../deploy/core-host.mjs';

const token = 'private-fixture-token';
const sha256 = createHash('sha256').update(token).digest('hex');
const configuration = {
  host: '127.0.0.1', port: 2470,
  principals: [{ id: 'first', kind: 'person', person: 'first' }, { id: 'second', kind: 'person', person: 'second' }],
  scopes: [{ id: 'first-chat', principalId: 'first' }, { id: 'second-chat', principalId: 'second' }],
  credentials: [{ sha256, principalId: 'first', purpose: 'service', scopeIds: ['first-chat'] }],
};
const binding = { version: 1, user: 'first', scopeId: 'first-chat', tokenFile: '/private/first/token' };

test('transport bindings require the exact existing principal, scope and service credential', () => {
  assert.equal(personBinding(configuration, binding, token + '\n').ok, true);
  for (const input of [
    { ...binding, user: 'second' }, { ...binding, scopeId: 'second-chat' },
    { ...binding, tokenFile: 'relative/token' }, { ...binding, user: '../first' },
  ]) assert.equal(personBinding(configuration, input, token).ok, false);
  assert.equal(personBinding(configuration, binding, 'wrong-token').ok, false);
  const humanOnly = { ...configuration, credentials: [{ ...configuration.credentials[0], purpose: 'person' }] };
  assert.equal(personBinding(humanOnly, binding, token).ok, false);
  assert.equal(personBinding({ ...configuration, credentials: [{ ...configuration.credentials[0], scopeIds: [] }] }, binding, token).ok, false);
});
