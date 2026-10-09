#!/usr/bin/env node
// Repair only the known existing maintenance HTTP listener; never an agent/provider.
const [pidText, uidText, address, portText] = process.argv.slice(2);
const pid = Number(pidText), uid = Number(uidText), port = Number(portText);
if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(uid) || uid < 0
  || !Number.isSafeInteger(port) || port <= 0 || port > 65535
  || !address?.startsWith('/') || !/\/\.native-history-[a-f0-9]{16}\.sock$/.test(address)) throw new Error('Exact process/UID/maintenance address/owned inspector port required');
const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
const targets = await response.json();
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
  const message = JSON.parse(event.data);
  const operation = pending.get(message.id);
  if (!operation) return;
  pending.delete(message.id); clearTimeout(operation.timer);
  message.error ? operation.reject(new Error(message.error.message)) : operation.resolve(message.result);
});
function rpc(method, params) {
  const id = ++next;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Inspector operation timed out')); }, 4000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error('Target maintenance operation rejected');
  return result.result.value;
}
let ownInspector = false;
try {
  const identity = await evaluate(`({pid:process.pid,uid:process.getuid()})`);
  if (identity.pid !== pid || identity.uid !== uid) throw new Error('Inspector does not belong to the authorized process/UID');
  ownInspector = true;
  const proof = await evaluate(`(async()=>{
    if(process.pid!==${pid}||process.getuid()!==${uid})throw new Error('Process identity changed');
    const address=${JSON.stringify(address)};
    const http=process.getBuiltinModule('node:http'),fs=process.getBuiltinModule('node:fs'),net=process.getBuiltinModule('node:net');
    const servers=process._getActiveHandles().filter(h=>h instanceof http.Server&&h.address()===address);
    if(servers.length!==1)return {ready:false,state:'listener-not-unique',pid:process.pid,uid:process.getuid(),servers:servers.length};
    const server=servers[0];
    const connections=await new Promise((r,j)=>server.getConnections((e,n)=>e?j(e):r(n)));
    if(connections!==0)return {ready:false,state:'maintenance-connections-active',pid:process.pid,uid:process.getuid(),connections};
    const reachable=await new Promise((r,j)=>{
      const socket=net.createConnection(address);socket.setTimeout(500,()=>{socket.destroy();j(new Error('Endpoint probe unavailable'));});
      socket.once('connect',()=>{socket.destroy();r(true);});
      socket.once('error',e=>{socket.destroy();['ENOENT','ECONNREFUSED'].includes(e.code)?r(false):j(e);});
    });
    if(reachable)return {ready:false,state:'endpoint-already-owned',pid:process.pid,uid:process.getuid()};
    if(fs.existsSync(address)){
      const file=fs.lstatSync(address);
      if(!file.isSocket()||file.uid!==process.getuid())throw new Error('Stale endpoint is not this own socket');
      fs.unlinkSync(address);
    }
    await new Promise((r,j)=>server.close(e=>e?j(e):r()));
    await new Promise((r,j)=>{server.once('error',j);server.listen(address,()=>{server.removeListener('error',j);r();});});
    return {ready:true,state:'maintenance-listener-rebound',pid:process.pid,uid:process.getuid(),address:server.address(),connections,applicationRestarted:false};
  })()`);
  console.log(JSON.stringify(proof));
} finally {
  if (ownInspector) {
    await evaluate(`(()=>{if(process.pid!==${pid}||process.getuid()!==${uid})throw new Error('Identity changed');const inspector=process.getBuiltinModule('node:inspector');setTimeout(()=>{try{inspector.close();}catch(error){console.error('Maintenance inspector close failed:',error.code??error.name);}},0);return 'inspector-close-requested';})()`);
  }
  ws.close();
}
