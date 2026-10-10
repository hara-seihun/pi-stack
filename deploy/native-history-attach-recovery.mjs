#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

const [pidText, uidText, portText, oldApi, database, candidate] = process.argv.slice(2);
const pid = Number(pidText), uid = Number(uidText), port = Number(portText);
if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(uid) || uid < 0
  || !Number.isSafeInteger(port) || port <= 0 || port > 65535 || !oldApi?.startsWith('/srv/pi/.pi-stack-releases/orchestrator/')
  || !database?.startsWith('/') || !/^[a-f0-9]{40}$/.test(candidate)) throw new Error('Exact legacy owner/source/database/candidate required');
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) })).json();
if (!Array.isArray(targets) || targets.length !== 1 || !targets[0].webSocketDebuggerUrl?.startsWith(`ws://127.0.0.1:${port}/`)) throw new Error('Expected one owned loopback inspector');
const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Inspector did not open')), 3000);
  ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
  ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Inspector transport failed')); }, { once: true });
});
let next = 0;
const pending = new Map();
ws.addEventListener('message', event => {
  const message = JSON.parse(event.data), operation = pending.get(message.id);
  if (!operation) return;
  pending.delete(message.id); clearTimeout(operation.timer);
  message.error ? operation.reject(new Error(message.error.message)) : operation.resolve(message.result);
});
function rpc(method, params) {
  const id = ++next;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Inspector operation timed out')); }, 15000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression, returnByValue = true) {
  const result = await rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue });
  if (result.exceptionDetails) throw new Error(`Target maintenance operation rejected: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
  return returnByValue ? result.result.value : result.result;
}
let owned = false;
try {
  const identity = await evaluate('({pid:process.pid,uid:process.getuid()})');
  if (identity.pid !== pid || identity.uid !== uid) throw new Error('Inspector process/UID mismatch');
  owned = true;
  const expression = `(async()=>(await import(${JSON.stringify(pathToFileURL(oldApi).href)})).ThreadService.prototype)()`;
  const prototype = await evaluate(`process.getBuiltinModule('node:vm').runInThisContext(${JSON.stringify(expression)},{importModuleDynamically:process.getBuiltinModule('node:vm').constants.USE_MAIN_CONTEXT_DEFAULT_LOADER})`, false);
  if (!prototype.objectId) throw new Error('Legacy ThreadService prototype unavailable');
  const instances = await rpc('Runtime.queryObjects', { prototypeObjectId: prototype.objectId });
  const result = await rpc('Runtime.callFunctionOn', {
    objectId: instances.objects.objectId, awaitPromise: true, returnByValue: true,
    arguments: [{ value: database }, { value: candidate }],
    functionDeclaration: `async function(database,candidate) {
      const fs=process.getBuiltinModule('node:fs'),path=process.getBuiltinModule('node:path');
      const receipt=JSON.parse(fs.readFileSync(path.join(path.dirname(database),'native-history-maintenance.json'),'utf8'));
      if(receipt.candidate!==candidate||receipt.phase!=='draining')throw new Error('Retiring owner receipt mismatch');
      const matches=this.filter(service=>!service.closed&&!service.suspended&&service.started&&service.options.databasePath===database);
      if(matches.length!==1)throw new Error('Expected exactly one live retiring thread service');
      const service=matches[0];
      const rows=service.sql("SELECT t.id FROM thread_execution e CROSS JOIN thread t ON t.id=e.thread_id WHERE e.ended_at IS NULL AND json_extract(t.metadata,'$.runnerReference') IS NOT NULL").all();
      let attached=0,alreadyAttached=0,transitioning=0;
      for(const {id} of rows){
        if(service.runtimes.has(id)){alreadyAttached++;continue;}
        if(service.opening.has(id)||service.operations.has(id)||service.halts.has(id)){transitioning++;continue;}
        if(!service.execution(id)||!service.get(id)?.metadata?.runnerReference)throw new Error('Accepted producer custody changed');
        const runtime=await service.attach(id);
        if(!runtime)throw new Error('Retained producer is absent; recovery requires its owning contract');
        attached++;
      }
      return {pid:process.pid,uid:process.getuid(),candidate,acceptedExecutions:rows.length,attached,alreadyAttached,transitioning,newInputDispatched:false};
    }`,
  });
  if (result.exceptionDetails) throw new Error('Accepted execution reattachment rejected');
  console.log(JSON.stringify(result.result.value));
} finally {
  if (owned) await evaluate(`(()=>{if(process.pid!==${pid}||process.getuid()!==${uid})throw new Error('Inspector identity changed');setTimeout(()=>process.getBuiltinModule('node:inspector').close(),0);return 'inspector-close-requested';})()`);
  ws.close();
}
