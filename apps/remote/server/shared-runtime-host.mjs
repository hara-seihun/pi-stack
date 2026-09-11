import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer } from 'node:net';
import { appendFileSync, closeSync, createReadStream, existsSync, openSync, truncateSync, unlinkSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { underMemoryPressure } from './shared-runtime-memory.mjs';

const [controlPath] = process.argv.slice(2);
if (!controlPath) throw new Error('shared-runtime-host requires its control socket');
const scope = globalThis[Symbol.for('pi-stack.session-environment')] ??= new AsyncLocalStorage();
const { openSession } = await import(process.env.PI_REMOTE_SESSION_FACTORY || './shared-session.mjs');
const sessions = new Map();
let stopping = false;
let idleTimer;
const MAX_SESSIONS = Number(process.env.PI_REMOTE_MAX_ACTIVE_RUNTIMES || 8);
const MAX_RSS = Number(process.env.PI_REMOTE_RUNNER_MAX_RSS_MB || 6144) * 1024 * 1024;

function lines(socket, onLine) {
  const reader = createInterface({input: socket, crlfDelay: Infinity});
  reader.on('line', line => { try { onLine(JSON.parse(line)); } catch (error) { socket.end(JSON.stringify({error: String(error)}) + '\n'); } });
  socket.on('error', () => {});
}
function reply(socket, value) { if (socket.writable) socket.write(JSON.stringify(value) + '\n'); }

async function open(options) {
  if (stopping) throw new Error('Runner is stopping');
  if (sessions.has(options.socketPath)) return;
  if (sessions.size >= MAX_SESSIONS || process.memoryUsage().rss >= MAX_RSS || underMemoryPressure()) throw new Error('Runner capacity busy; work remains queued');
  clearTimeout(idleTimer);
  const {socketPath} = options;
  if (existsSync(socketPath)) throw new Error('Session socket already exists');
  const env = {...options.env};
  const spoolPath = socketPath + '.events';
  const fd = openSync(spoolPath, 'ax', 0o600);
  let client = null, sequence = 0, acknowledged = 0, closed = false, replaying = false, adapter;
  const channel = createServer(socket => {
    client?.destroy(); client = socket; socket.setNoDelay(true);
    lines(socket, value => {
      if (value.type === 'attach') {
        replaying = true;
        reply(socket, {type: 'attached', pid: process.pid, shared: true, sequence});
        // Spool replay is streamed, not retained as an unbounded in-memory queue.
        void (async () => {
          let after = Math.max(acknowledged, Number(value.after || 0));
          do {
            const reader = createInterface({input: createReadStream(spoolPath), crlfDelay: Infinity});
            for await (const line of reader) {
              if (!socket.writable || closed || client !== socket) break;
              const event = JSON.parse(line);
              if (event.sequence > after) {
                if (!socket.write(JSON.stringify(event) + '\n')) await new Promise(resolve => {
                  const done = () => { socket.off('drain', done); socket.off('close', done); resolve(); };
                  socket.once('drain', done); socket.once('close', done);
                });
                after = event.sequence;
              }
            }
          } while (socket.writable && !closed && client === socket && after < sequence);
          if (client === socket) replaying = false;
        })().catch(error => { if (!closed) console.error('Runner replay:', error); });
      } else if (value.type === 'ack') {
        acknowledged = Math.max(acknowledged, Number(value.sequence || 0));
        if (!replaying && acknowledged === sequence) truncateSync(spoolPath, 0);
      } else if (value.type === 'command') {
        // Initialization is shared with all commands, but prompts themselves
        // acknowledge preflight and continue asynchronously in their own session.
        void ready.then(() => scope.run(env, () => adapter.command(value.value))).catch(error => publish({id: value.value?.id, type:'response',command:value.value?.type,success:false,error:String(error)}));
      } else if (value.type === 'terminate') void close();
    });
    socket.on('close', () => { if (client === socket) client = null; });
  });
  function publish(value) {
    if (closed) return;
    const record = {type:'output', sequence:++sequence, line:JSON.stringify(value)};
    appendFileSync(fd, JSON.stringify(record) + '\n');
    if (client?.writableLength > 4 * 1024 * 1024) { client.destroy(); client = null; }
    if (!replaying) reply(client ?? {}, record);
  }
  function finish(code = 0) {
    if (closed) return;
    closed = true;
    reply(client ?? {}, {type:'exit',code}); client?.end(); channel.close();
    closeSync(fd);
    for (const path of [socketPath,spoolPath]) { try { unlinkSync(path); } catch {} }
    sessions.delete(socketPath);
    if (!sessions.size && !stopping) idleTimer = setTimeout(() => void stop(), 5000);
  }
  async function close() {
    try { await ready; await scope.run(env, () => adapter.close()); }
    catch (error) { console.error('Session close:', error); }
    finally { finish(); }
  }
  sessions.set(socketPath, {close});
  channel.listen(socketPath);
  const ready = scope.run(env, () => openSession(options, publish, finish)).then(value => { adapter = value; }).catch(error => {
    publish({type:'extension_error',error:String(error)});
    console.error(`Runner session ${options.sessionId}:`,error);
    setTimeout(() => finish(1),100);
    throw error;
  });
  void ready.catch(() => {});
}

const server = createServer(socket => {
  lines(socket, value => {
    if (value.type === 'open') void open(value.options).then(() => reply(socket,{ok:true,pid:process.pid}),error => reply(socket,{error:String(error)}));
    else if (value.type === 'close') void Promise.resolve(sessions.get(value.socketPath)?.close()).then(() => reply(socket,{ok:true}));
    else if (value.type === 'status') reply(socket,{ok:true,pid:process.pid,sessions:sessions.size,rss:process.memoryUsage().rss});
  });
});
server.on('error', error => { if (error.code === 'EADDRINUSE') process.exit(0); throw error; });
server.listen(controlPath);
async function stop() {
  if (stopping) return;
  stopping = true; clearTimeout(idleTimer);
  await Promise.allSettled([...sessions.values()].map(session => session.close()));
  server.close(); try { unlinkSync(controlPath); } catch {}
  process.exit(0);
}
for (const signal of ['SIGTERM','SIGINT']) process.on(signal, () => void stop());
