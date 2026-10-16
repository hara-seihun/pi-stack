import { mkdtempSync, chmodSync, chownSync, statSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { adoptMarkdownDuties } from '../packages/orchestrator/src/core/duties.js';

const uid=Number(process.argv[2]),gid=Number(process.argv[3]);
if (process.getuid?.()!==0 || !Number.isSafeInteger(uid) || uid<=0 || !Number.isSafeInteger(gid) || gid<0) throw new Error('Explicit nonroot target UID/GID required under root');
const root=mkdtempSync(join(tmpdir(),'duty-owner-'));chmodSync(root,0o700);chownSync(root,uid,gid);
const service={exportWakeDuties:()=>[],get:()=>null} as unknown as Parameters<typeof adoptMarkdownDuties>[0]['service'];
try {
  const path=join(root,'notes','duties.md');
  const created=adoptMarkdownDuties({service,path,uid,gid});
  if (!created.ok) throw new Error(created.error.message);
  const metadata=statSync(path);
  if (metadata.uid!==uid || metadata.gid!==gid || (metadata.mode&0o777)!==0o600) throw new Error('New duty ownership differs from declared owner');
  const read=spawnSync('/usr/bin/setpriv',[`--reuid=${uid}`,`--regid=${gid}`,'--clear-groups','--','/usr/bin/head','-c','1',path],{encoding:'utf8',timeout:3000});
  if (read.status!==0 || !read.stdout) throw new Error('Actual target UID cannot read first-created duty');
  const existing=join(root,'existing.md');writeFileSync(existing,'# Original notes\n');chmodSync(existing,0o640);
  const before=statSync(existing);const adopted=adoptMarkdownDuties({service,path:existing,uid,gid});
  if (!adopted.ok) throw new Error(adopted.error.message);
  const after=statSync(existing);
  if (before.uid!==after.uid || before.gid!==after.gid || (before.mode&0o777)!==(after.mode&0o777) || !readFileSync(existing,'utf8').startsWith('# Original notes\n')) throw new Error('Existing note ownership or content not preserved');
  console.log(JSON.stringify({ok:true,createdOwner:uid,targetRead:true,existingOwnerPreserved:true}));
} finally {rmSync(root,{recursive:true,force:true});}
