#!/usr/bin/env node
// Project internal image custody for the already registered room service.
// Human audience checks remain in the owning Remote room routes.
import {readFileSync,lstatSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export function projectRoomImageCustody(input, binding, evidence) {
  const fail = message => ({ok:false,error:{code:'room-image-custody-mismatch',message}});
  if (!evidence || !/^[a-f0-9]{64}$/.test(evidence.authoritySha256) || !Number.isSafeInteger(evidence.now))
    return fail('Exact binding authority and projection time required');
  const scope = input.scopes?.find(s => s.id === 'rooms');
  const principal = input.principals?.find(p => p.id === 'pi-rooms');
  const gateways = input.gatewayBindings?.filter(b => b.scopeIds?.includes('rooms'));
  const images = input.images?.registries?.filter(r => r.scopeId === 'rooms');
  const image = images?.[0], resource = image?.dataResource;
  if (scope?.principalId !== 'pi-rooms' || scope.resource?.owner !== 'pi-rooms' ||
      scope.resource.consent !== 'not-required' || principal?.kind !== 'service' ||
      binding?.version !== 1 || binding.user !== 'pi-rooms' || binding.scopeId !== 'rooms' ||
      binding.gatewayId !== 'remote-rooms' || gateways?.length !== 1 ||
      gateways[0].gatewayId !== binding.gatewayId || gateways[0].principalId !== 'pi-rooms' ||
      gateways[0].peerUid !== scope.custody.uid || scope.custody.uid !== 973 ||
      gateways[0].scopeIds.length !== 1 || input.credentials?.some(c => c.scopeIds?.includes('rooms')))
    return fail('Only the existing UID973 kernel-bound room custodian may enter');
  if (images?.length !== 1 || resource?.id !== 'images:rooms' || resource.kind !== 'data' ||
      resource.owner !== 'pi-rooms' || resource.privacy !== 'confidential' ||
      resource.consent !== 'required' ||
      JSON.stringify(resource.subjects) !== JSON.stringify(scope.resource.subjects))
    return fail('Original confidential room image registry required');
  if (!input.policy?.grants?.some(g => g.id === 'room-custodian-thread-scope-v1' &&
      g.principal === 'pi-rooms' && g.resource?.kind === 'exact' && g.resource.id === 'scope:rooms') ||
      input.policy.grants.some(g => g.resource?.id === resource.id ||
        g.resource?.kind === 'owned-kind' && g.resource.owner === resource.owner && g.resource.resourceKind === resource.kind) ||
      input.policy.consents.some(c => c.resource === resource.id))
    return fail('Existing image audience authority requires its owning reconciliation');
  const result = structuredClone(input);
  result.images.registries.find(r => r.scopeId === 'rooms').dataResource.consent = 'not-required';
  result.policy.revision++;
  result.policy.grants.push({id:'room-custodian-image-registry-v1',principal:'pi-rooms',
    resource:{kind:'exact',id:resource.id},actions:['read','execute','use'],effect:'allow',
    validFrom:evidence.now,validUntil:null,issuedBy:'pi-rooms',
    source:'room-image-custodian-projection-v1 authority-sha256:'+evidence.authoritySha256});
  return {ok:true,value:result};
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [inputPath, expected, authorityPath, outputPath] = process.argv.slice(2);
    if (process.argv.length !== 6 || ![inputPath,authorityPath,outputPath].every(isAbsolute) ||
        !/^[a-f0-9]{64}$/.test(expected)) throw Error('Exact protected config, digest, binding and candidate required');
    for (const p of [inputPath,authorityPath]) {
      const s=lstatSync(p);if(!s.isFile() || s.uid!==0 || s.mode&0o022) throw Error('Protected root inputs required');
    }
    const raw=readFileSync(inputPath),authority=readFileSync(authorityPath);
    if(sha(raw)!==expected)throw Error('Live configuration changed');
    const r=projectRoomImageCustody(JSON.parse(raw),JSON.parse(authority),{authoritySha256:sha(authority),now:Date.now()});
    if(!r.ok)throw Error(r.error.message);
    const bytes=JSON.stringify(r.value,null,2)+'\n';writeFileSync(outputPath,bytes,{flag:'wx',mode:0o600});
    console.log(JSON.stringify({ok:true,protocol:'room-image-custodian-projection-v1',inputSha256:expected,
      authoritySha256:sha(authority),candidateSha256:sha(bytes),outputPath,liveEffects:false}));
  } catch(e) {console.error(JSON.stringify({ok:false,error:String(e.message)}));process.exitCode=1;}
}
