// Read-only installed observer proof. Uses only a disposable private file/process.
// Run on the managed host with its normal passwordless root observation grant.
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
const directory=mkdtempSync(path.join(tmpdir(),'growth-observer-'));
const entry=new URL('./workspace.mjs',import.meta.url).pathname;
const child=spawn(process.execPath,['-e',`const fs=require('node:fs');const f=fs.openSync(${JSON.stringify(path.join(directory,'write-held'))},'w');console.log('ready');setInterval(()=>fs.writeSync(f,'x'),1000);`],{stdio:['ignore','pipe','pipe']});
try {
 await once(child.stdout,'data');
 const references=JSON.parse(execFileSync('sudo',['-n',process.execPath,entry,'growth-process-snapshot','--path',directory],{encoding:'utf8',timeout:15000}));
 assert.ok(references.some(value=>value.pid===child.pid && value.matches.some(match=>match.startsWith('write-fd:'))),'foreign/all-UID observer must find writable fd, not only cwd/arguments');
 console.log(JSON.stringify({ok:true,kind:'installed-strict-process-observer',writableFdDetected:true,referenceCount:references.length}));
} finally {child.kill('SIGKILL');await once(child,'exit');rmSync(directory,{recursive:true,force:true});}
