import { expect, test } from 'vitest';
import { projectRoomCustody } from '../../../deploy/core-room-custody.mjs';
import { authorize, type PermissionPolicy, type Resource } from '../src/permissions.js';

const evidence = { authoritySha256: 'a'.repeat(64), now: 100 };
function fixture() {
  const resource: Resource = { id: 'scope:rooms', owner: 'pi-rooms', kind: 'thread', privacy: 'confidential', subjects: ['alice', 'bob'], consent: 'required' };
  const policy: PermissionPolicy = { revision: 7, grants: [{ id: 'exact-room', principal: 'alice', resource: { kind: 'exact', id: 'room:one' }, actions: ['read'], effect: 'allow', validFrom: 0, validUntil: null, issuedBy: 'owner', source: 'membership' }], consents: [] };
  return { principals: [{ kind: 'service', id: 'pi-rooms' }], scopes: [{ id: 'rooms', principalId: 'pi-rooms', resource, custody: { uid: 973 } }],
    gatewayBindings: [{ gatewayId: 'remote-rooms', principalId: 'pi-rooms', peerUid: 973, scopeIds: ['rooms'] }], credentials: [] as { scopeIds: string[] }[], policy };
}

test('only internal custodian gains scope custody; real audience and thread policy are unchanged', () => {
  const input = fixture(), before = structuredClone(input), result = projectRoomCustody(input, evidence);
  expect(result.ok).toBe(true); if (!result.ok) throw Error(result.error.message);
  expect(input).toEqual(before);
  const { policy, scopes } = result.value, resource = scopes[0]!.resource;
  for (const action of ['read', 'write', 'dispatch', 'control'] as const) {
    expect(authorize(policy, { principal: { kind: 'service', id: 'pi-rooms' }, resource, action, now: 100 }).ok).toBe(true);
    for (const person of ['alice', 'bob', 'outsider']) expect(authorize(policy, { principal: { kind: 'person', id: person, person }, resource, action, now: 100 }).ok).toBe(false);
  }
  expect(authorize(policy, { principal: { kind: 'service', id: 'pi-rooms' }, resource, action: 'disclose', now: 100 }).ok).toBe(false);
  expect(policy.consents).toEqual(before.policy.consents);
  expect(policy.grants.slice(0, -1)).toEqual(before.policy.grants);
  expect(resource).toEqual({ ...before.scopes[0]!.resource, consent: 'not-required' });
  expect(result.value.gatewayBindings).toEqual(before.gatewayBindings);
  expect(projectRoomCustody(result.value, evidence).ok).toBe(false);
});

test('rejects changed owner, person ingress, bearer or prior broad scope authority', () => {
  const cases = [
    (x: ReturnType<typeof fixture>) => { x.scopes[0]!.principalId = 'alice'; },
    (x: ReturnType<typeof fixture>) => { x.gatewayBindings[0]!.peerUid = 1000; },
    (x: ReturnType<typeof fixture>) => { x.gatewayBindings.push({ gatewayId: 'person', principalId: 'alice', peerUid: 1000, scopeIds: ['rooms'] }); },
    (x: ReturnType<typeof fixture>) => { x.credentials.push({ scopeIds: ['rooms'] }); },
    (x: ReturnType<typeof fixture>) => { x.policy = { ...x.policy, grants: [...x.policy.grants, { ...x.policy.grants[0]!, id: 'wide', resource: { kind: 'owned-kind', owner: 'pi-rooms', resourceKind: 'thread' } }] }; },
  ];
  for (const change of cases) { const input = fixture(); change(input); expect(projectRoomCustody(input, evidence).ok).toBe(false); }
});
