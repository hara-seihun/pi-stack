#!/usr/bin/env node
import { readFileSync, lstatSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

const fail = message => ({ ok: false, error: { code: 'room-custody-mismatch', message } });
const hash = value => createHash('sha256').update(value).digest('hex');

export function projectRoomCustody(input, evidence) {
  if (!evidence || !/^[a-f0-9]{64}$/.test(evidence.authoritySha256) || !Number.isSafeInteger(evidence.now) || evidence.now < 0)
    return fail('Exact authority digest and projection time required');
  if (!input || !Array.isArray(input.scopes) || !Array.isArray(input.principals) || !Array.isArray(input.gatewayBindings)
    || !Array.isArray(input.credentials) || !Array.isArray(input.policy?.grants) || !Array.isArray(input.policy?.consents)
    || !Number.isSafeInteger(input.policy.revision) || input.policy.revision < 1 || input.policy.revision === Number.MAX_SAFE_INTEGER)
    return fail('Explicit Core scope, principal, gateway, credential and policy inventories required');
  const scopes = input.scopes.filter(scope => scope.id === 'rooms');
  const scope = scopes[0], resource = scope?.resource;
  if (scopes.length !== 1 || scope.principalId !== 'pi-rooms' || resource?.id !== 'scope:rooms' || resource.kind !== 'thread'
    || resource.owner !== 'pi-rooms' || resource.privacy !== 'confidential' || resource.consent !== 'required'
    || !Array.isArray(resource.subjects) || !resource.subjects.length || resource.subjects.some(value => typeof value !== 'string' || !value)
    || !Number.isSafeInteger(scope.custody?.uid) || scope.custody.uid <= 0)
    return fail('Expected original confidential room custodian scope');
  const principals = input.principals.filter(principal => principal.id === 'pi-rooms');
  if (principals.length !== 1 || principals[0].kind !== 'service') return fail('Room custodian must be the original service principal');
  const bindings = input.gatewayBindings.filter(binding => binding.scopeIds?.includes('rooms'));
  if (bindings.length !== 1 || bindings[0].gatewayId !== 'remote-rooms' || bindings[0].principalId !== 'pi-rooms'
    || bindings[0].peerUid !== scope.custody.uid || bindings[0].scopeIds.length !== 1)
    return fail('Only the original kernel-bound custodian may enter the shared room scope');
  if (input.credentials.some(credential => credential.scopeIds?.includes('rooms')))
    return fail('Shared room bearer credentials are not part of custodian projection');
  const matchesScope = grant => grant.resource?.kind === 'exact' && grant.resource.id === resource.id
    || grant.resource?.kind === 'owned-kind' && grant.resource.owner === resource.owner && grant.resource.resourceKind === resource.kind;
  if (input.policy.grants.some(matchesScope) || input.policy.consents.some(consent => consent.resource === resource.id))
    return fail('Existing shared-scope grants or consents require their owning reconciliation');
  const id = 'room-custodian-thread-scope-v1';
  if ([...input.policy.grants, ...input.policy.consents].some(value => value.id === id)) return fail('Projection receipt identity already exists');
  const config = structuredClone(input);
  config.scopes.find(value => value.id === 'rooms').resource.consent = 'not-required';
  config.policy.revision++;
  config.policy.grants.push({ id, principal: 'pi-rooms', resource: { kind: 'exact', id: resource.id },
    actions: ['read', 'write', 'dispatch', 'control'], effect: 'allow', validFrom: evidence.now, validUntil: null,
    issuedBy: 'pi-rooms', source: `room-custodian-projection-v1 authority-sha256:${evidence.authoritySha256}` });
  return { ok: true, value: config };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [inputPath, expectedSha256, authorityPath, outputPath] = process.argv.slice(2);
    if (process.argv.length !== 6 || ![inputPath, authorityPath, outputPath].every(value => typeof value === 'string' && isAbsolute(value))
      || !/^[a-f0-9]{64}$/.test(expectedSha256)) throw Error('usage: core-room-custody.mjs ABS_CONFIG EXPECTED_SHA256 ABS_AUTHORITY_RECORD ABS_CANDIDATE');
    for (const path of [inputPath, authorityPath]) {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.uid !== 0 || stat.mode & 0o022) throw Error('Projection inputs require protected root custody');
    }
    const raw = readFileSync(inputPath), authority = readFileSync(authorityPath);
    if (hash(raw) !== expectedSha256) throw Error('Core configuration changed before projection');
    const result = projectRoomCustody(JSON.parse(raw), { authoritySha256: hash(authority), now: Date.now() });
    if (!result.ok) throw Error(result.error.message);
    const output = JSON.stringify(result.value, null, 2) + '\n';
    writeFileSync(outputPath, output, { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ protocol: 'room-custodian-projection-v1', state: 'staged', inputSha256: expectedSha256,
      authoritySha256: hash(authority), candidateSha256: hash(output), outputPath }));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: { code: 'room-custody-projection-failed', message: String(error.message ?? error) } }));
    process.exitCode = 1;
  }
}
