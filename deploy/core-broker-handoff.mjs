import { createHash } from 'node:crypto';
import { readFileSync, statSync, lstatSync, realpathSync, openSync, closeSync, writeFileSync, fsyncSync, renameSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve, dirname, isAbsolute } from 'node:path';

export function admissionExpression(identity, ports) {
  return `(()=>{
    if(process.pid!==${identity.pid}||process.getuid()!==${identity.uid})throw new Error('broker identity changed');
    const fs=process.getBuiltinModule('node:fs');
    if(fs.readFileSync('/proc/self/stat','utf8').split(')').slice(1).join(')').trim().split(/\\s+/)[19]!==${JSON.stringify(identity.startTicks)})throw new Error('broker birth changed');
    const key=Symbol.for('pi.core.broker.handoff.v1');
    let state=globalThis[key];
    if(state){if(state.id!==${JSON.stringify(identity.id)})throw new Error('another handoff owns intake');return {state:state.state,ports:state.ports,drainedAt:state.drainedAt};}
    const http=process.getBuiltinModule('node:http');
    const expected=${JSON.stringify(ports)};
    const servers=process._getActiveHandles().filter(handle=>handle instanceof http.Server);
    if(servers.length!==expected.length||servers.some(server=>!server.listening||!expected.includes(server.address()?.port)))throw new Error('exact old broker listeners not exposed');
    state={id:${JSON.stringify(identity.id)},state:'draining',ports:expected,remaining:servers.length,drainedAt:null,retained:[]};
    globalThis[key]=state;
    for(const server of servers){
      state.retained.push({server,request:server.rawListeners('request'),upgrade:server.rawListeners('upgrade')});
      server.removeAllListeners('request');server.removeAllListeners('upgrade');
      server.on('request',(_request,response)=>{response.writeHead(503,{'content-type':'application/json','connection':'close'});response.end(JSON.stringify({error:'original broker intake is draining'}));});
      server.on('upgrade',(_request,socket)=>{socket.end('HTTP/1.1 503 Service Unavailable\\r\\nConnection: close\\r\\n\\r\\n');});
      server.close(error=>{if(error){state.state='failed';state.error=String(error);return;}if(--state.remaining===0){state.state='drained';state.drainedAt=new Date().toISOString();}});
    }
    return {state:state.state,ports:state.ports,drainedAt:state.drainedAt};
  })()`;
}

export async function inspectorEvaluate(endpoint, expression, expectedSource = null) {
  const socket = new WebSocket(endpoint);
  let next = 0;
  const pending = new Map();
  const scripts = new Set();
  const opened = new Promise((accept, reject) => {
    socket.addEventListener('open', accept, { once: true });
    socket.addEventListener('error', () => reject(new Error('inspector connection failed')), { once: true });
  });
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    if (message.method === 'Debugger.scriptParsed') scripts.add(message.params.url);
    const operation = pending.get(message.id);
    if (operation) { pending.delete(message.id); operation(message); }
  });
  try {
    let openingTimer;
    try { await Promise.race([opened, new Promise((_, reject) => { openingTimer = setTimeout(() => reject(new Error('inspector connection uncertain')), 2000); })]); }
    finally { clearTimeout(openingTimer); }
    if (expectedSource !== null) {
      await new Promise((accept, reject) => {
        const id = ++next;
        const timer = setTimeout(() => reject(new Error('runtime source attestation uncertain')), 2000);
        pending.set(id, message => { clearTimeout(timer); message.error ? reject(new Error('runtime source attestation unavailable')) : accept(); });
        socket.send(JSON.stringify({ id, method: 'Debugger.enable' }));
      });
      if (!scripts.has(pathToFileURL(expectedSource).href)) throw new Error('declared original broker module is not loaded in this runtime');
    }
    return await new Promise((accept, reject) => {
      const id = ++next;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('inspector acknowledgement uncertain; recover same handoff')); }, 3000);
      pending.set(id, message => {
        clearTimeout(timer);
        if (message.error || message.result?.exceptionDetails) reject(new Error('broker handoff runtime rejected operation'));
        else accept(message.result.result.value);
      });
      socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
    });
  } finally { socket.close(); }
}

function rootPlan(path) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.uid !== 0 || metadata.mode & 0o022 || realpathSync(path) !== path) throw new Error('protected canonical root broker handoff plan required');
  return JSON.parse(readFileSync(path, 'utf8'));
}
export function isOriginalBrokerUnit(unit, configPath) {
  if (/^pi-(?:model|kenan)-broker\.service$/.test(unit)) return true;
  const match = /^pi-stack-model-broker@([a-z_][a-z0-9_-]{0,31})\.service$/.exec(unit);
  return match !== null && configPath === `/var/lib/pi-stack-oidc/brokers/${match[1]}.json`;
}
export async function handoff(plan) {
  if (process.getuid() !== 0 || plan.version !== 1 || !isOriginalBrokerUnit(plan.unit, plan.configPath) || !Number.isSafeInteger(plan.pid) || plan.pid < 1 || !Number.isSafeInteger(plan.uid) || !/^\d+$/.test(plan.startTicks) || !Array.isArray(plan.ports) || plan.ports.length === 0 || new Set(plan.ports).size !== plan.ports.length || plan.ports.some(port => !Number.isSafeInteger(port) || port < 1 || port > 65535) || plan.inspectorPort !== 9229) throw new Error('exact original broker unit/process/listeners and fixed loopback inspector required');
  const unit = spawnSync('/usr/bin/systemctl', ['show', plan.unit, '--property=MainPID', '--value'], { encoding: 'utf8', timeout: 2000 });
  if (unit.status !== 0 || Number(unit.stdout.trim()) !== plan.pid || statSync(`/proc/${plan.pid}`).uid !== plan.uid) throw new Error('original broker unit identity changed');
  const fields = readFileSync(`/proc/${plan.pid}/stat`, 'utf8').split(')').slice(1).join(')').trim().split(/\s+/);
  if (fields[19] !== plan.startTicks) throw new Error('original broker birth changed');
  const source = realpathSync(plan.sourcePath);
  if (!/^\/srv\/pi\/\.pi-stack-releases\/orchestrator\/[a-f0-9]{40}\/dist\/model-broker\.js$/.test(source) || source !== plan.sourcePath || createHash('sha256').update(readFileSync(source)).digest('hex') !== plan.sourceSha256) throw new Error('old broker source binding changed');
  const argv = readFileSync(`/proc/${plan.pid}/cmdline`, 'utf8').split('\0');
  if (!argv.includes('model-broker') || !argv.includes(plan.configPath)) throw new Error('original broker command is not its declared config');
  const original = rootPlan(plan.configPath);
  if (JSON.stringify(original.listeners.map(listener => listener.port).sort((a,b)=>a-b)) !== JSON.stringify([...plan.ports].sort((a,b)=>a-b))) throw new Error('original broker listener topology differs');
  const id = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
  const base = 'http://127.0.0.1:9229';
  let targets;
  try { targets = await (await fetch(base + '/json/list', { signal: AbortSignal.timeout(500) })).json(); }
  catch { process.kill(plan.pid, 'SIGUSR1'); }
  if (!targets) {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      try { targets = await (await fetch(base + '/json/list', { signal: AbortSignal.timeout(250) })).json(); break; }
      catch { await new Promise(accept => setTimeout(accept, 20)); }
    }
  }
  if (!Array.isArray(targets) || targets.length !== 1 || !targets[0].webSocketDebuggerUrl?.startsWith('ws://127.0.0.1:9229/')) throw new Error('one owned loopback inspector unavailable');
  const endpoint = targets[0].webSocketDebuggerUrl;
  const identity = await inspectorEvaluate(endpoint, '({pid:process.pid,uid:process.getuid()})');
  if (identity.pid !== plan.pid || identity.uid !== plan.uid) throw new Error('loopback inspector belongs to another process; no operation sent');
  try {
    const result = await inspectorEvaluate(endpoint, admissionExpression({ pid: plan.pid, uid: plan.uid, startTicks: plan.startTicks, id }, plan.ports), source);
    if (!['draining', 'drained'].includes(result?.state)) throw new Error('broker intake drain failed or unconfirmed');
    const value = { protocol: 'pi-core-original-broker-drain-v1', handoffId: id, pid: plan.pid, state: result.state, drainedAt: result.drainedAt, accepted: result.state === 'drained' ? 0 : null };
    if (result.state === 'drained') {
      if (!isAbsolute(plan.proofPath ?? '') || resolve(plan.proofPath) !== plan.proofPath) throw new Error('declared protected positive drain proof path required');
      const parent = lstatSync(dirname(plan.proofPath));
      if (!parent.isDirectory() || parent.uid !== 0 || parent.mode & 0o022) throw new Error('positive drain proof parent is not protected');
      const temporary = `${plan.proofPath}.${process.pid}.tmp`;
      const fd = openSync(temporary, 'wx', 0o600);
      try { writeFileSync(fd, JSON.stringify({ version: 1, ...value, unit: plan.unit, startTicks: plan.startTicks, uid: plan.uid, ports: plan.ports, sourcePath: plan.sourcePath, sourceSha256: plan.sourceSha256 }) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, plan.proofPath);
      const directory = openSync(dirname(plan.proofPath), 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
    return { ok: true, value };
  } finally {
    await inspectorEvaluate(endpoint, `(()=>{if(process.pid!==${plan.pid})return false;const inspector=process.getBuiltinModule('node:inspector');setTimeout(()=>inspector.close(),0);return true;})()`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error('usage: root node core-broker-handoff.mjs ABSOLUTE_ROOT_PLAN');
    console.log(JSON.stringify(await handoff(rootPlan(resolve(process.argv[2])))));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: { code: 'broker-handoff-unconfirmed', message: String(error) } }));
    process.exitCode = 75;
  }
}
