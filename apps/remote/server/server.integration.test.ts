import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test as bunTest } from "bun:test";
import { Database } from "bun:sqlite";
import { OrchestratorClient } from "pi-orchestrator/api";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { applyContextSplice, contextSplice, sha256 } from "./sync";
const BOOSTED_MULTIPLIER = 10;
const [shardIndex = 0, shardCount = 1] = (process.env.PI_REMOTE_TEST_SHARD ?? "0/1")
  .split("/").map(Number);
if (!Number.isSafeInteger(shardIndex) || !Number.isSafeInteger(shardCount)
  || shardIndex < 0 || shardCount < 1 || shardIndex >= shardCount) {
  throw new Error("PI_REMOTE_TEST_SHARD must be a zero-based INDEX/COUNT");
}
let testIndex = 0;
const test = (name: string, body: () => unknown, timeout?: number) => {
  const selected = testIndex++ % shardCount === shardIndex;
  return selected ? bunTest(name, body, timeout) : bunTest.skip(name, body, timeout);
};

const root = mkdtempSync(join(tmpdir(), "pi-remote-state-test-"));
const fakePi = join(root, "fake-pi.py");
const fakeAudio = join(root, "fake-audio.py");
const fakeAudioState = join(root, "fake-audio-state.json");
const fakeLaunch = join(root, "fake-launch.json");
const fakeRpcLog = join(root, "fake-rpc.jsonl");
const fakeChildPid = join(root, "fake-child.pid");
const fakeCrashMarker = join(root, "fake-crash.marker");
const fakeRestartMarker = join(root, "fake-restart.marker");
const fakeGateRoot = join(root, "gates");
const fakeOrchestratorDb = join(root, "orchestrator.sqlite3");
const fakeAgentRuns = join(root, "agent-runs");
const port = 20_000 + ((process.ppid * 4 + shardIndex) % 10_000);
const base = `http://127.0.0.1:${port}`;
let server: ReturnType<typeof Bun.spawn>;
setDefaultTimeout(30_000);

async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(base + path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json() as any;
  return { status: response.status, value, stateVersion: response.headers.get("x-pi-state-version") };
}

async function waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value!: T;
  while (Date.now() < deadline) {
    value = await read();
    if (accept(value)) return value;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for state; last value: ${JSON.stringify(value)}`);
}

function readJsonLines(path: string): any[] {
  if (!existsSync(path)) return [];
  const content = readFileSync(path, "utf8");
  const completeEnd = content.lastIndexOf("\n");
  if (completeEnd < 0) return [];
  return content.slice(0, completeEnd).split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function gatePath(name: string, state: "ready" | "release") {
  return join(fakeGateRoot, `${name}.${state}`);
}

function resetGate(name: string) {
  rmSync(gatePath(name, "ready"), { force: true });
  rmSync(gatePath(name, "release"), { force: true });
}

async function waitForGate(name: string) {
  await waitFor(async () => existsSync(gatePath(name, "ready")), Boolean);
}

function releaseGate(name: string) {
  writeFileSync(gatePath(name, "release"), "release");
}

async function startServer() {
  server = Bun.spawn([process.execPath, join(import.meta.dir, "server.ts")], {
    cwd: import.meta.dir,
    stdout: "ignore",
    stderr: "pipe",
    env: {
      ...process.env,
      PATH: `${root}:${process.env.PATH ?? ""}`,
      PI_BIN: fakePi,
      PI_REMOTE_ACTIONS: JSON.stringify([{ id: "thunder", label: "Thunder", icon: "thunder", status: [fakeAudio, "status"], on: [fakeAudio, "thunder"], off: [fakeAudio, "stop"] }]),
      PI_FAKE_AUDIO_STATE: fakeAudioState,
      PI_REMOTE_DATA: join(root, "data"),
      PI_REMOTE_PORT: String(port),
      PI_AGENT_DIR: join(root, "agent"),
      PI_REMOTE_PROMPT_ACK_TIMEOUT_MS: "100",
      PI_REMOTE_STATE_RECONCILE_MS: "5",
      // A runtime host is a fresh bun process; four shards starting hosts on a
      // loaded CI runner need seconds, not the sub-second budgets the rest of
      // this fixture uses. Nothing here waits for a host that never comes up.
      PI_REMOTE_RUNTIME_CONNECT_TIMEOUT_MS: "2000",
      PI_REMOTE_RUNTIME_START_TIMEOUT_MS: "8000",
      PI_REMOTE_RUNTIME_TERMINATE_TIMEOUT_MS: "200",
      PI_REMOTE_RUNTIME_START_POLL_MS: "2",
      PI_REMOTE_RUNTIME_RESTART_DELAY_MS: "20",
      PI_REMOTE_INGESTION: join(root, "ingestion"),
      PI_FAKE_LAUNCH: fakeLaunch,
      PI_FAKE_RPC_LOG: fakeRpcLog,
      PI_FAKE_CHILD_PID: fakeChildPid,
      PI_FAKE_CRASH_MARKER: fakeCrashMarker,
      PI_FAKE_RESTART_MARKER: fakeRestartMarker,
      PI_FAKE_GATE_ROOT: fakeGateRoot,
      PI_FAKE_TIME_SCALE: "0.05",
      PI_REMOTE_ORCHESTRATOR_DB: fakeOrchestratorDb,
      PI_ORCHESTRATOR_AUTH: join(root, "agent", "auth.json"),
      PI_REMOTE_ORCHESTRATOR_RUNS: fakeAgentRuns,
      PI_REMOTE_LOCAL_AGENT_MAX_AGE_MS: "0",
      PI_REMOTE_ENVIRONMENT_ID: "local",
      PI_REMOTE_ENVIRONMENT_NAME: "Local",
      PI_REMOTE_REQUIRES_UNLOCK: "true",
      PI_REMOTE_PRIVATE_ID: "private",
      PI_REMOTE_PRIVATE_NAME: "Private",
      PI_REMOTE_PRIVATE_DIR: join(root, "private"),
      PI_REMOTE_DESTINATIONS: "personal,home",
      PI_REMOTE_WORKSPACES: JSON.stringify([
        { id: "home", name: "Home", path: join(root, "home") },
        { id: "private", name: "Private", path: join(root, "private") },
        { id: "pi-remote", name: "Pi Remote", path: join(import.meta.dir, "..") },
      ]),
      PI_REMOTE_THREAD_DESTINATIONS: JSON.stringify([
        { id: "personal", label: "PERSONAL", icon: "personal", accent: "#a371f7", workspaceId: "private", thinkingLevel: "low", models: ["sol", "opus", "fable"], defaultModel: "fable" },
        { id: "home", label: "HOME", icon: "house", accent: "#3fb950", workspaceId: "home", thinkingLevel: "high", models: ["sol", "fable", "opus"], defaultModel: "opus" },
      ]),
    },
  });
  await waitFor(() => fetch(base + "/v1/health").then((response) => response.ok).catch(() => false), Boolean);
}

beforeAll(async () => {
  await Bun.write(fakePi, `#!/usr/bin/env python3
import json, os, subprocess, sys, threading, time
scale = float(os.environ.get('PI_FAKE_TIME_SCALE', '1'))
def pause(seconds): time.sleep(seconds * scale)
def gate(name):
 root = os.environ['PI_FAKE_GATE_ROOT']
 os.makedirs(root, exist_ok=True)
 ready = os.path.join(root, name + '.ready')
 release = os.path.join(root, name + '.release')
 for path in (ready, release):
  try: os.unlink(path)
  except FileNotFoundError: pass
 with open(ready, 'w') as marker: marker.write('ready')
 while not os.path.exists(release): time.sleep(0.001)
 os.unlink(ready)
 os.unlink(release)
provider = sys.argv[sys.argv.index('--provider') + 1] if '--provider' in sys.argv else 'anthropic'
model_id = sys.argv[sys.argv.index('--model') + 1] if '--model' in sys.argv else 'claude-fable-5-1'
thinking_level = sys.argv[sys.argv.index('--thinking') + 1] if '--thinking' in sys.argv else 'off'
with open(os.environ['PI_FAKE_LAUNCH'], 'w') as launch:
 json.dump({'argv': sys.argv, 'pid': os.getpid(), 'sessionId': os.environ.get('PI_REMOTE_SESSION_ID'), 'serverUrl': os.environ.get('PI_REMOTE_SERVER_URL'), 'serviceTierFile': os.environ.get('PI_REMOTE_SERVICE_TIER_FILE'), 'agentDir': os.environ.get('PI_CODING_AGENT_DIR'), 'offline': os.environ.get('PI_OFFLINE')}, launch)
streaming = False
compacting = False
last = ''
session_name = None
steering = []
follow_up = []
first_state = True
child = None
def out(value):
 print(json.dumps(value), flush=True)
def finish_release_later():
 global streaming
 gate('release-later')
 out({'type':'message_end','message':{'role':'assistant','content':[{'type':'text','text':'current finished'}]}})
 streaming = False
 out({'type':'agent_settled'})
for line in sys.stdin:
 try: request = json.loads(line)
 except Exception: continue
 with open(os.environ['PI_FAKE_RPC_LOG'], 'a') as rpc_log:
  rpc_log.write(json.dumps({'sessionId': os.environ.get('PI_REMOTE_SESSION_ID'), **request}) + '\\n')
 kind = request.get('type')
 rid = request.get('id')
 if kind == 'get_state':
  if first_state:
   first_state = False
   pause(0.12)
  out({'type':'response','id':rid,'command':'get_state','success':True,'data':{'isStreaming':streaming,'isCompacting':compacting,'pendingMessageCount':len(steering)+len(follow_up),'messageCount':0,'thinkingLevel':thinking_level,'sessionFile':None,'sessionName':session_name,'model':{'provider':provider,'id':model_id,'name':model_id}}})
 elif kind == 'get_available_models':
  out({'type':'response','id':rid,'command':kind,'success':True,'data':{'models':[
   {'provider':'openai-codex-2','id':'gpt-5.6-sol','name':'GPT-5.6 Sol duplicate'},
   {'provider':'openai-codex','id':'gpt-5.6-sol','name':'GPT-5.6 Sol'},
   {'provider':'openai-codex','id':'gpt-5.6-luna','name':'GPT-5.6 Luna'},
   {'provider':'openai-codex','id':'gpt-5.5','name':'GPT-5.5'},
   {'provider':'anthropic','id':'claude-fable-5-1','name':'Claude Fable 5.1'},
   {'provider':'anthropic-2','id':'claude-fable-5-1','name':'Claude Fable 5.1 (#2)'},
   {'provider':'anthropic-3','id':'claude-fable-5-1','name':'Claude Fable 5.1 (#3)'},
   {'provider':'anthropic','id':'claude-opus-5','name':'Claude Opus 5'},
   {'provider':'anthropic-2','id':'claude-opus-5','name':'Claude Opus 5 (#2)'},
   {'provider':'anthropic-3','id':'claude-opus-5','name':'Claude Opus 5 (#3)'},
   {'provider':'anthropic','id':'claude-sonnet-4','name':'Claude Sonnet 4'},
   {'provider':'anthropic-2','id':'claude-sonnet-4','name':'Claude Sonnet 4 (#2)'},
   {'provider':'anthropic-3','id':'claude-sonnet-4','name':'Claude Sonnet 4 (#3)'}
  ]}})
 elif kind == 'get_available_thinking_levels':
  out({'type':'response','id':rid,'command':kind,'success':True,'data':{'levels':['off','low','high']}})
 elif kind == 'set_model':
  provider = request.get('provider', provider); model_id = request.get('modelId', model_id)
  out({'type':'response','id':rid,'command':kind,'success':True,'data':{'provider':provider,'id':model_id,'name':model_id}})
 elif kind == 'set_thinking_level':
  thinking_level = request.get('level', thinking_level)
  out({'type':'response','id':rid,'command':kind,'success':True})
 elif kind == 'set_session_name':
  session_name = request.get('name')
  out({'type':'response','id':rid,'command':'set_session_name','success':True})
 elif kind == 'prompt':
  last = request.get('message','')
  if last == 'retry-prompt':
   out({'type':'response','id':rid,'command':'prompt','success':False,'error':'simulated rejection'})
   continue
  streaming = True
  if last == 'slow-ack': gate('slow-ack')
  elif last == 'slow-ack-auto': pause(0.35)
  if last != 'ack-timeout': out({'type':'response','id':rid,'command':'prompt','success':True})
  if last == 'slow-ack' or last == 'slow-ack-auto':
   out({'type':'agent_start'})
   out({'type':'message_end','message':{'role':'assistant','content':[{'type':'text','text':'slow ack done'}]}})
   streaming = False
   out({'type':'agent_settled'})
  elif last == 'delayed-start':
   gate('delayed-start')
   out({'type':'agent_start'})
   out({'type':'message_end','message':{'role':'assistant','content':[{'type':'text','text':'started after reconcile'}]}})
   streaming = False
   out({'type':'agent_settled'})
  elif last == 'stale-settled':
   out({'type':'agent_settled'})
   pause(0.2)
   out({'type':'agent_start'})
   pause(0.2)
   out({'type':'message_end','message':{'role':'assistant','content':[{'type':'text','text':'done once'}]}})
   streaming = False
   out({'type':'agent_settled'})
  else:
   out({'type':'agent_start'})
   if last == 'live-stream':
    out({'type':'message_update','message':{'role':'assistant','content':[{'type':'thinking','thinking':'thinking now'}]},'assistantMessageEvent':{'type':'thinking_delta','delta':'thinking now'}})
    out({'type':'message_update','message':{'role':'assistant','content':[{'type':'text','text':'instant text'}]},'assistantMessageEvent':{'type':'text_delta','delta':'instant text'}})
    gate('live-stream-next')
    out({'type':'message_update','message':{'role':'assistant','content':[{'type':'text','text':'instant text second'}]},'assistantMessageEvent':{'type':'text_delta','delta':' second'}})
    gate('live-stream')
    out({'type':'message_end','message':{'role':'assistant','content':[{'type':'text','text':'instant text second'}]}})
    streaming = False
    out({'type':'agent_settled'})
   elif last == 'release-later':
    threading.Thread(target=finish_release_later, daemon=True).start()
   elif last == 'later-run' or '<new_user_message>\\nlater-run\\n</new_user_message>' in last:
    out({'type':'message_end','message':{'role':'assistant','content':[{'type':'text','text':'later ran'}]}})
    streaming = False
    out({'type':'agent_settled'})
   elif last == 'compact':
    streaming = False
    compacting = True
    out({'type':'agent_settled'})
    out({'type':'compaction_start','reason':'threshold'})
    gate('compaction')
    compacting = False
    out({'type':'compaction_end','reason':'threshold','result':{'summary':'done'},'aborted':False,'willRetry':False})
    streaming = True
    out({'type':'agent_start'})
    out({'type':'message_end','message':{'role':'assistant','content':[{'type':'text','text':'done'}]}})
    streaming = False
    out({'type':'agent_settled'})
   elif last == 'model-refusal':
    out({'type':'message_end','message':{'role':'assistant','content':[{'type':'thinking','thinking':''}],'stopReason':'error','rawStopReason':'refusal','errorMessage':'Blocked by the provider policy'}})
    streaming = False
    out({'type':'agent_settled'})
   elif last == 'account-failover':
    out({'type':'message_end','message':{'role':'assistant','content':[],'stopReason':'error','errorMessage':'Codex error: The usage limit has been reached'}})
    out({'type':'message_end','message':{'role':'assistant','content':[{'type':'text','text':'continued on next account'}],'stopReason':'stop'}})
    streaming = False
    out({'type':'agent_settled'})
   elif 'restart-once' in last:
    if not os.path.exists(os.environ['PI_FAKE_RESTART_MARKER']):
     with open(os.environ['PI_FAKE_RESTART_MARKER'], 'w') as marker: marker.write('started')
     pause(60)
    out({'type':'message_end','message':{'role':'assistant','content':[{'type':'text','text':'recovered after supervisor restart'}]}})
    streaming = False
    out({'type':'agent_settled'})
   elif 'crash-once' in last:
    if not os.path.exists(os.environ['PI_FAKE_CRASH_MARKER']):
     with open(os.environ['PI_FAKE_CRASH_MARKER'], 'w') as marker: marker.write('crashed')
     os._exit(17)
    out({'type':'message_end','message':{'role':'assistant','content':[{'type':'text','text':'recovered after disconnect'}]}})
    streaming = False
    out({'type':'agent_settled'})
   elif last == 'lease-exit':
    pause(0.3)
    os._exit(143)
   elif last == 'group-child':
    child = subprocess.Popen(['sleep', '60'])
    with open(os.environ['PI_FAKE_CHILD_PID'], 'w') as child_pid:
     child_pid.write(str(child.pid))
    out({'type':'tool_execution_start','toolCallId':'bash-1','toolName':'bash','args':{'command':'sleep 60'}})
   elif last == 'ack-timeout':
    gate('ack-timeout')
    out({'type':'message_end','message':{'role':'assistant','content':[{'type':'text','text':'ack was lost'}]}})
    streaming = False
    out({'type':'agent_settled'})
 elif kind == 'steer':
  steering.append(request.get('message',''))
  out({'type':'queue_update','steering':steering,'followUp':follow_up})
  out({'type':'response','id':rid,'command':'steer','success':True})
 elif kind == 'follow_up':
  follow_up.append(request.get('message',''))
  out({'type':'queue_update','steering':steering,'followUp':follow_up})
  out({'type':'response','id':rid,'command':'follow_up','success':True})
 elif kind == 'abort':
  if last == 'abort-refuse':
   out({'type':'response','id':rid,'command':'abort','success':False,'error':'simulated refusal'})
  else:
   streaming = False
   compacting = False
   if child is not None:
    child.terminate()
    try: child.wait(timeout=2)
    except subprocess.TimeoutExpired: child.kill()
    child = None
   if steering or follow_up:
    pause(0.3)
    out({'type':'message_end','message':{'role':'assistant','content':[{'type':'text','text':'cancelled queue executed'}]}})
   out({'type':'response','id':rid,'command':'abort','success':True})
   steering.clear()
   follow_up.clear()
   out({'type':'queue_update','steering':steering,'followUp':follow_up})
 else:
  out({'type':'response','id':rid,'command':kind,'success':True,'data':{}})
`);
  chmodSync(fakePi, 0o700);
  await Bun.write(fakeAudio, `#!/usr/bin/env python3
import json, os, sys
state_path = os.environ['PI_FAKE_AUDIO_STATE']
action = sys.argv[1]
def write(value):
 with open(state_path, 'w') as state: json.dump(value, state)
 print(json.dumps(value))
if action == 'status':
 # Exit 0 while playing, 1 while stopped: the contract of a Pi Remote action.
 value = json.load(open(state_path)) if os.path.exists(state_path) else {'status':'stopped'}
 print(json.dumps(value))
 sys.exit(0 if value.get('status') == 'playing' else 1)
elif action == 'thunder': write({'kind':'thunder','status':'playing'})
elif action == 'stop': write({'status':'stopped'})
else: sys.exit(2)
`);
  chmodSync(fakeAudio, 0o700);
  // Both ledgers are pi-orchestrator's: every agent host runs the same
  // orchestrator, and the work host below is read exactly like this one.
  new OrchestratorClient({ ledgerPath: fakeOrchestratorDb, runsRoot: fakeAgentRuns }).close();
  const orchestrator = new Database(fakeOrchestratorDb, { strict: true });
  orchestrator.exec(`
    INSERT INTO account(id,provider,created_at) VALUES
      ('openai-codex','openai-codex',0),('anthropic','anthropic',0);
    INSERT INTO room(id,name,prompt,cwd,profile,budget,desired_members,created_at,updated_at)
      VALUES('room-1','fixture room','work','/tmp','standard','background',2,0,0);
  `);
  const insertRun = orchestrator.query(`INSERT INTO run
    (id,source,source_id,prompt,cwd,profile,budget,account_id,state,created_at,updated_at,started_at,provider,model)
    VALUES(?,\"lane\",?,\"work\",\"/tmp\",\"standard\",\"background\",\"openai-codex\",?,0,0,0,\"openai-codex\",?)`);
  for (let index = 0; index < 122; index++) insertRun.run(`sol-${index}`, "sol-task", "running", "openai-codex/gpt-5.6-sol");
  insertRun.run("opus-mixed", "sol-task", "running", "anthropic/claude-opus-5");
  for (let index = 0; index < 45; index++) insertRun.run(`luna-${index}`, "luna-task", "running", "openai-codex/gpt-5.6-luna");
  insertRun.run("sonnet", "sonnet-task", "running", "anthropic/claude-sonnet");
  insertRun.run("finished", "luna-task", "done", "openai-codex/gpt-5.6-luna");
  const sessionFile = join(fakeAgentRuns, "sol-0.jsonl");
  orchestrator.query(`UPDATE run SET started_at=1000,provider='openai-codex-3',thinking='xhigh',room_id='room-1',member_name='coordinator',session_file=?
    WHERE id='sol-0'`).run(sessionFile);
  orchestrator.query(`UPDATE run SET room_id='room-1',member_name='member-2' WHERE id='sol-1'`).run();
  orchestrator.query(`UPDATE run SET started_at=500,ended_at=900,provider='openai-codex-2',thinking='max'
    WHERE id='finished'`).run();
  orchestrator.query(`INSERT INTO live_state(run_id,activity,text,thinking,updated_at) VALUES('sol-0','THINKING','','weighing options',0)`).run();
  orchestrator.close();
  mkdirSync(fakeAgentRuns, { recursive: true });
  writeFileSync(sessionFile, [
    { type: "message", timestamp: "2026-08-18T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "claim one unit" }] } },
    { type: "message", timestamp: "2026-08-18T00:00:02.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } }] } },
    { type: "message", timestamp: "2026-08-18T00:00:03.000Z", message: { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "ledger.sqlite3" }] } },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n");
  for (const directory of [join(root, "home"), join(root, "private")]) {
    mkdirSync(directory, { recursive: true });
  }
  // Shared Codex custody fixture: the ledger above registers openai-codex,
  // and this central auth file makes exactly one voice account eligible.
  mkdirSync(join(root, "agent"), { recursive: true });
  writeFileSync(join(root, "agent", "auth.json"), JSON.stringify({
    "openai-codex": { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3_600_000, accountId: "acct" },
  }));
  writeFileSync(join(root, "agent", "settings.json"), JSON.stringify({
    packages: [join(import.meta.dir, "..")],
  }));
  await startServer();
});

afterAll(async () => {
  server?.kill();
  await server?.exited.catch(() => {});
  rmSync(root, { recursive: true, force: true });
});

async function createThread(destination = "home", model?: string) {
  const created = await api("POST", "/v1/sessions", { requestId: crypto.randomUUID(), destination, model });
  expect(created.status).toBe(201);
  const id = created.value.session.id as string;
  await waitFor(
    () => api("GET", "/v1/sessions").then((result) => result.value.sessions.find((session: any) => session.id === id)),
    (session) => session?.state === "IDLE",
  );
  return id;
}

describe("web and supervisor integration", () => {
  test("exposes host-configured actions as toggles it knows nothing about", async () => {
    const before = await (await fetch(`${base}/v1/actions`)).json();
    expect(before.actions).toEqual([{ id: "thunder", label: "Thunder", icon: "thunder", active: false }]);
    const on = await (await fetch(`${base}/v1/actions/thunder/toggle`, { method: "POST" })).json();
    expect(on.action.active).toBe(true);
    const off = await (await fetch(`${base}/v1/actions/thunder/toggle`, { method: "POST" })).json();
    expect(off.action.active).toBe(false);
    expect((await fetch(`${base}/v1/actions/nope/toggle`, { method: "POST" })).status).toBe(404);
  });

  test("serves the complete browser module graph", async () => {
    for (const path of ["/app.js", "/api.js", "/context-cache.js", "/reconciliation.js", "/state-machine.js", "/native.js", "/person.js"]) {
      const response = await fetch(base + path);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/javascript");
    }
  });

  test("reconciles every acknowledged mutation through its committed state version", async () => {
    const id = await createThread("home", "sol");
    const before = await api("POST", "/v1/sync", {
      after: 0,
      stateVersion: 0,
      waitMs: 0,
      includeDashboard: false,
    });
    const renamed = await fetch(`${base}/v1/sessions/${id}/name`, { method: "PUT", body: "Reconciled thread" });
    expect(renamed.status).toBe(200);
    const target = renamed.headers.get("x-pi-state-version") || "";
    const separator = target.lastIndexOf("/");
    expect(target.slice(0, separator)).toBe(before.value.epoch);
    const targetVersion = Number(target.slice(separator + 1));
    expect(targetVersion).toBeGreaterThan(before.value.stateVersion);

    const reconciled = await api("POST", "/v1/sync", {
      after: before.value.seq,
      stateVersion: before.value.stateVersion,
      epoch: before.value.epoch,
      waitMs: 25_000,
      includeDashboard: false,
    });
    expect(reconciled.value.stateVersion).toBeGreaterThanOrEqual(targetVersion);
    expect(reconciled.value.sessions.find((session: any) => session.id === id)?.name).toBe("Reconciled thread");
  });

  test("lists this host's working agents for observation", async () => {
    const listed = await api("GET", "/v1/agents/runs");
    expect(listed.status).toBe(200);
    expect(listed.value.running).toBe(169);
    expect(listed.value.hosts).toEqual([
      { key: "local", label: "THIS MACHINE", name: "This machine", running: 169, updatedAt: expect.any(String), error: null },
    ]);
    const observable = listed.value.runs.find((run: any) => run.id === "local:sol-0");
    expect(observable).toMatchObject({
      host: "local", hostName: "This machine", runId: "sol-0",
      taskId: "sol-task", status: "running", label: "SOL", provider: "openai-codex-3",
      thinking: "xhigh", teamRole: "supervisor", teamSlot: null,
      observable: true, activity: "THINKING",
    });
    // Settled runs never appear in the list, but stay observable by id so a run
    // that finishes while it is open does not vanish from the client.
    expect(listed.value.runs.every((run: any) => run.status === "running")).toBe(true);
    expect(listed.value.runs.find((run: any) => run.runId === "finished")).toBeUndefined();
    const settled = await api("GET", "/v1/agents/runs/local:finished/events");
    expect(settled.status).toBe(200);
    expect(settled.value.run).toMatchObject({ id: "local:finished", status: "done" });
  });

  test("streams one agent's transcript incrementally without any control surface", async () => {
    const first = await api("GET", "/v1/agents/runs/local:sol-0/events");
    expect(first.status).toBe(200);
    expect(first.value.events.map((event: any) => event.type)).toEqual(["user", "tool_start", "tool_end"]);
    expect(first.value.events[0].text).toBe("claim one unit");
    expect(first.value.events[2]).toMatchObject({ toolCallId: "t1", name: "bash", output: "ledger.sqlite3", error: false });
    expect(first.value.liveThinking).toBe("weighing options");
    expect(first.value.run).toMatchObject({ id: "local:sol-0", taskId: "sol-task", activity: "THINKING" });

    expect((await api("GET", "/v1/agents/runs/local:sol-0/events?after=3")).value.events).toEqual([]);
    expect((await api("GET", "/v1/agents/runs/local:missing-run/events")).status).toBe(404);
    expect((await api("GET", "/v1/agents/runs/local:%2E%2E%2Fescape/events")).status).toBe(400);
    expect((await api("GET", "/v1/agents/runs/nowhere:sol-0/events")).status).toBe(400);
    expect((await api("GET", "/v1/agents/runs/sol-0/events")).status).toBe(400);
    expect((await api("POST", "/v1/agents/runs/local:sol-0/events", {})).status).toBe(404);
  });

  test("serves Pi's provider-neutral context as the entire interactive transcript", async () => {
    const id = await createThread("home", "sol");
    const empty = await api("GET", `/v1/sessions/${id}/context`);
    expect(empty).toMatchObject({ status: 200, value: { capturedAt: 0, context: null } });

    const context = {
      systemPrompt: "# System\n\nLoaded AGENTS.md",
      tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }],
      messages: [
        { role: "user", content: [{ type: "text", text: "Inspect $x^2$." }], timestamp: 1 },
        { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "/tmp/a.md" } }], timestamp: 2 },
        { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "# Result" }], isError: false, timestamp: 3 },
      ],
    };
    const stored = await api("PUT", `/v1/sessions/${id}/context`, { capturedAt: 200, context });
    expect(stored).toMatchObject({ status: 200, value: { ok: true, capturedAt: 200, hash: expect.any(String) } });
    const mirrored = await api("GET", `/v1/sessions/${id}/context`);
    expect(mirrored.value.context).toEqual(context);

    await api("PUT", `/v1/sessions/${id}/context`, {
      capturedAt: 199,
      context: { systemPrompt: "stale", tools: [], messages: [] },
    });
    await api("PUT", `/v1/sessions/${id}/context`, {
      capturedAt: 200,
      context: { systemPrompt: "same-time stale", tools: [], messages: [] },
    });
    expect((await api("GET", `/v1/sessions/${id}/context`)).value).toMatchObject({ capturedAt: 200, context });
    expect((await api("PUT", `/v1/sessions/${id}/context`, { capturedAt: 201, context: { tools: [], messages: [] } })).status).toBe(400);
  });

  test("synchronizes a selected context with compressed verified splices", async () => {
    const id = await createThread("home", "sol");
    const firstContext = {
      systemPrompt: "System ".repeat(400),
      tools: [],
      messages: [{
        role: "assistant",
        provider: "openai",
        model: "model",
        responseId: "response",
        usage: { cost: { total: 1 } },
        content: [
          { type: "thinking", thinking: "consider", thinkingSignature: "opaque" },
          { type: "text", text: "first", textSignature: "opaque" },
        ],
      }],
    };
    await api("PUT", `/v1/sessions/${id}/context`, { capturedAt: 300, context: firstContext });
    const firstResponse = await fetch(`${base}/v1/sync`, {
      method: "POST",
      headers: { "content-type": "application/json", "accept-encoding": "gzip" },
      body: JSON.stringify({ after: 0, waitMs: 0, selectedId: id, contextHash: "", includeDashboard: false }),
    });
    expect(firstResponse.headers.get("content-encoding")).toBe("gzip");
    const first = await firstResponse.json() as any;
    expect(first.contextUpdate.kind).toBe("full");
    expect(JSON.parse(first.contextUpdate.document)).toEqual(firstContext);
    expect(first.archivedSessions).toBeNull();

    const display = await api("POST", "/v1/sync", {
      after: 0,
      waitMs: 0,
      selectedId: id,
      contextHash: "",
      contextProjection: "display",
      includeDashboard: false,
    });
    const displayDocument = JSON.parse(display.value.contextUpdate.document);
    expect(displayDocument).toEqual({
      systemPrompt: firstContext.systemPrompt,
      tools: [],
      messages: [{
        role: "assistant",
        content: [
          { type: "thinking", thinking: "consider" },
          { type: "text", text: "first" },
        ],
      }],
    });
    expect(display.value.contextUpdate.hash).not.toBe(first.contextUpdate.hash);

    const secondContext = { ...firstContext, messages: [{ role: "assistant", content: [{ type: "text", text: "first and second" }] }] };
    const baseDocument = JSON.stringify(firstContext);
    const targetDocument = JSON.stringify(secondContext);
    await api("PATCH", `/v1/sessions/${id}/context`, {
      capturedAt: 301,
      splice: contextSplice(baseDocument, targetDocument),
    });
    const second = await api("POST", "/v1/sync", {
      after: first.seq,
      waitMs: 0,
      selectedId: id,
      contextHash: first.contextUpdate.hash,
      includeDashboard: false,
    });
    expect(second.value.contextUpdate.kind).toBe("splice");
    expect(applyContextSplice(baseDocument, second.value.contextUpdate.splice)).toBe(targetDocument);
  });

  test("publishes live model text without rebuilding unchanged application state", async () => {
    const id = await createThread("home", "sol");
    resetGate("live-stream-next");
    resetGate("live-stream");
    try {
      await api("POST", `/v1/sessions/${id}/prompt`, { requestId: crypto.randomUUID(), text: "live-stream" });
      await waitForGate("live-stream-next");
      const first = await api("POST", "/v1/sync", {
        after: 0,
        stateVersion: 0,
        waitMs: 0,
        selectedId: id,
        eventSessionId: id,
        eventAfter: Number.MAX_SAFE_INTEGER,
        includeDashboard: false,
      });
      expect(first.value.sessionEvents.liveTextUpdate).toMatchObject({ kind: "full", document: "instant text" });
      expect(first.value.sessionEvents.liveThinkingUpdate).toMatchObject({ kind: "full", document: "thinking now" });

      releaseGate("live-stream-next");
      await waitForGate("live-stream");
      const second = await api("POST", "/v1/sync", {
        after: first.value.seq,
        stateVersion: first.value.stateVersion,
        epoch: first.value.epoch,
        waitMs: 1_000,
        selectedId: id,
        eventSessionId: id,
        eventAfter: Number.MAX_SAFE_INTEGER,
        eventLiveTextHash: first.value.sessionEvents.liveTextUpdate.hash,
        eventLiveThinkingHash: first.value.sessionEvents.liveThinkingUpdate.hash,
        includeDashboard: false,
      });
      expect(second.value.sessions).toBeNull();
      expect(second.value.selectedSession).toBeNull();
      expect(second.value.contextUpdate).toBeNull();
      expect(second.value.stateVersion).toBe(first.value.stateVersion);
      expect(applyContextSplice("instant text", second.value.sessionEvents.liveTextUpdate.splice)).toBe("instant text second");
    } finally {
      releaseGate("live-stream-next");
      releaseGate("live-stream");
    }
  });

  test("confirms an empty selected context even when the client has not loaded its cache yet", async () => {
    const id = await createThread("home", "sol");
    const result = await api("POST", "/v1/sync", {
      after: 0,
      waitMs: 0,
      selectedId: id,
      includeDashboard: false,
    });
    expect(result.value.contextUpdate).toEqual({ kind: "clear", capturedAt: 0, hash: "" });
  });

  test("resumes uploads by committed offset and serves byte ranges", async () => {
    const id = await createThread("home", "sol");
    const content = Buffer.from("resumable attachment content");
    const requestId = crypto.randomUUID();
    const initialized = await api("POST", "/v1/uploads/init", {
      requestId, sessionId: id, name: "resumable.txt", contentType: "text/plain", size: content.length,
    });
    const uploadId = initialized.value.upload.id;
    const first = content.subarray(0, 10);
    const firstResponse = await fetch(`${base}/v1/uploads/${uploadId}?offset=0`, {
      method: "PUT", headers: { "x-chunk-sha256": sha256(first) }, body: first,
    });
    expect(firstResponse.status).toBe(200);
    const resumed = await api("POST", "/v1/uploads/init", {
      requestId, sessionId: id, name: "resumable.txt", contentType: "text/plain", size: content.length,
    });
    expect(resumed.value.upload.offset).toBe(10);
    const rest = content.subarray(10);
    expect((await fetch(`${base}/v1/uploads/${uploadId}?offset=10`, {
      method: "PUT", headers: { "x-chunk-sha256": sha256(rest) }, body: rest,
    })).status).toBe(200);
    const completed = await api("POST", `/v1/uploads/${uploadId}/complete`, { sha256: sha256(content) });
    expect(readFileSync(completed.value.file.path)).toEqual(content);
    const ranged = await fetch(`${base}/v1/sessions/${id}/files?path=${encodeURIComponent(completed.value.file.path)}`, {
      headers: { range: "bytes=10-19" },
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toBe(`bytes 10-19/${content.length}`);
    expect(Buffer.from(await ranged.arrayBuffer())).toEqual(content.subarray(10, 20));
  });

  test("holds later messages durably and promotes them to steering", async () => {
    const id = await createThread();
    const first = await api("POST", `/v1/sessions/${id}/prompt`, {
      requestId: crypto.randomUUID(), text: "hold-queue", delivery: "followUp",
    });
    expect(first.value).toMatchObject({ accepted: true, queued: false, delivery: "prompt" });
    await waitFor(
      () => api("GET", `/v1/sessions/${id}`).then((result) => result.value.session),
      (session) => session?.state === "RUNNING",
    );
    const steering = await api("POST", `/v1/sessions/${id}/prompt`, {
      requestId: crypto.randomUUID(), text: "change direction", delivery: "steer",
    });
    const followUp = await api("POST", `/v1/sessions/${id}/prompt`, {
      requestId: crypto.randomUUID(), text: "do this later", delivery: "followUp",
    });
    expect(steering.value).toMatchObject({ queued: true, delivery: "steer" });
    expect(followUp.value).toMatchObject({ queued: true, delivery: "followUp" });
    const beforePromotion = await waitFor(
      () => api("GET", `/v1/sessions/${id}`).then((result) => result.value.session),
      (session) => session.queuedMessages?.some((message: any) => message.text === "do this later"),
    );
    expect(beforePromotion.followUpQueued).toBe(1);
    const queued = beforePromotion.queuedMessages.find((message: any) => message.text === "do this later");
    expect(queued).toMatchObject({ delivery: "followUp", state: "queued", canSteer: true });
    const rpcBeforePromotion = readJsonLines(fakeRpcLog)
      .filter((entry: any) => entry.sessionId === id);
    expect(rpcBeforePromotion.some((entry: any) => entry.type === "follow_up")).toBe(false);
    const promoted = await api("POST", `/v1/sessions/${id}/queue/${queued.id}/steer`, {});
    expect(promoted.value).toMatchObject({ ok: true, delivery: "steer" });
    await waitFor(
      async () => readJsonLines(fakeRpcLog).filter((entry: any) => entry.sessionId === id),
      (entries) => entries.some((entry: any) => entry.type === "steer" && entry.message === "change direction")
        && entries.some((entry: any) => entry.type === "steer" && entry.message === "do this later"),
    );
    const listed = await waitFor(
      () => api("GET", `/v1/sessions/${id}`).then((result) => result.value),
      (value) => value.session.steeringQueued === 2
        && value.session.followUpQueued === 0
        && value.session.queuedMessages.length === 0,
    );
    expect(listed.session).toMatchObject({ steeringQueued: 2, followUpQueued: 0, queuedMessages: [] });
    const events = await api("GET", `/v1/sessions/${id}/events?after=0`);
    expect(events.value.events.filter((event: any) => event.type === "user").map((event: any) => [event.text, event.delivery]))
      .toEqual(expect.arrayContaining([
        ["hold-queue", "prompt"], ["change direction", "steer"], ["do this later", "steer"],
      ]));
    expect(events.value.events.some((event: any) => event.type === "user_delivery")).toBe(false);
    const invalid = await api("POST", `/v1/sessions/${id}/prompt`, {
      requestId: crypto.randomUUID(), text: "bad delivery", delivery: "eventually",
    });
    expect(invalid).toMatchObject({ status: 400, value: { error: "delivery must be steer or followUp" } });
    await api("DELETE", `/v1/sessions/${id}`);
  }, 20_000);

  test("cancels supervisor-owned messages and returns their text for editing", async () => {
    const id = await createThread();
    await api("POST", `/v1/sessions/${id}/prompt`, {
      requestId: crypto.randomUUID(), text: "hold-queue", delivery: "followUp",
    });
    await waitFor(
      () => api("GET", `/v1/sessions/${id}`).then((result) => result.value.session),
      (session) => session?.state === "RUNNING",
    );
    await api("POST", `/v1/sessions/${id}/prompt`, {
      requestId: crypto.randomUUID(), text: "cancel this message", delivery: "followUp",
    });
    await api("POST", `/v1/sessions/${id}/prompt`, {
      requestId: crypto.randomUUID(), text: "edit this message", delivery: "followUp",
    });
    const queued = await waitFor(
      () => api("GET", `/v1/sessions/${id}`).then((result) => result.value.session),
      (session) => session.queuedMessages?.filter((message: any) => message.canCancel).length === 2,
    );
    const cancelMessage = queued.queuedMessages.find((message: any) => message.text === "cancel this message");
    const editMessage = queued.queuedMessages.find((message: any) => message.text === "edit this message");
    expect(cancelMessage).toMatchObject({ state: "queued", canCancel: true });
    expect(editMessage).toMatchObject({ state: "queued", canCancel: true });

    const cancelled = await api("DELETE", `/v1/sessions/${id}/queue/${cancelMessage.id}`);
    expect(cancelled.value).toMatchObject({ ok: true, text: "cancel this message" });
    expect(cancelled.value.session.queuedMessages.map((message: any) => message.text)).not.toContain("cancel this message");
    const edited = await api("DELETE", `/v1/sessions/${id}/queue/${editMessage.id}`);
    expect(edited.value).toMatchObject({ ok: true, text: "edit this message" });
    expect(edited.value.session).toMatchObject({ followUpQueued: 0, queuedMessages: [] });
    const alreadyCancelled = await api("DELETE", `/v1/sessions/${id}/queue/${editMessage.id}`);
    expect(alreadyCancelled).toMatchObject({ status: 409, value: { error: "Message has already started" } });

    const commands = readJsonLines(fakeRpcLog)
      .filter((entry: any) => entry.sessionId === id);
    expect(commands.some((entry: any) => ["cancel this message", "edit this message"].includes(entry.message))).toBe(false);
    await api("DELETE", `/v1/sessions/${id}`);
  }, 15_000);

  test("keeps unconfirmed sends above the composer and out of the transcript", async () => {
    const id = await createThread();
    resetGate("slow-ack");
    const accepted = await api("POST", `/v1/sessions/${id}/prompt`, { requestId: crypto.randomUUID(), text: "slow-ack" });
    await waitForGate("slow-ack");
    try {
      const pending = await waitFor(
        () => api("GET", `/v1/sessions/${id}`).then((result) => result.value.session),
        (session) => session.queuedMessages?.some((message: any) => message.text === "slow-ack"),
      );
      expect(pending.queuedMessages.find((message: any) => message.text === "slow-ack")).toMatchObject({
        canSteer: false,
        delivery: "prompt",
      });
      const beforeAck = await api("GET", `/v1/sessions/${id}/events?after=0`);
      expect(beforeAck.value.events.some((event: any) => event.type === "user" && event.text === "slow-ack")).toBe(false);
    } finally {
      releaseGate("slow-ack");
    }
    const inserted = await waitFor(
      () => api("GET", `/v1/sessions/${id}/events?after=0`).then((result) => result.value),
      (value) => value.events.some((event: any) => event.type === "assistant" && event.text === "slow ack done"),
    );
    const userEvents = inserted.events.filter((event: any) => event.type === "user" && event.text === "slow-ack");
    expect(userEvents).toHaveLength(1);
    expect(userEvents[0].workId).toBe(accepted.value.workId);
    expect(inserted.session.queuedMessages).toEqual([]);
  }, 15_000);

  test("runs a durable later message only after the current run settles", async () => {
    const id = await createThread();
    resetGate("release-later");
    await api("POST", `/v1/sessions/${id}/prompt`, { requestId: crypto.randomUUID(), text: "release-later" });
    await waitForGate("release-later");
    const later = await api("POST", `/v1/sessions/${id}/prompt`, {
      requestId: crypto.randomUUID(), text: "later-run", delivery: "followUp",
    });
    expect(later.value).toMatchObject({ queued: true, delivery: "followUp" });
    const queued = await api("GET", `/v1/sessions/${id}`);
    expect(queued.value.session.queuedMessages.map((message: any) => message.text)).toContain("later-run");
    releaseGate("release-later");
    const events = await waitFor(
      () => api("GET", `/v1/sessions/${id}/events?after=0`).then((result) => result.value),
      (value) => value.session.state === "IDLE" &&
        value.events.some((event: any) => event.type === "assistant" && event.text === "later ran"),
    );
    expect(events.events.filter((event: any) => event.type === "assistant").map((event: any) => event.text))
      .toEqual(["current finished", "later ran"]);
    expect(events.session).toMatchObject({ state: "IDLE", queuedMessages: [] });
    const commands = readJsonLines(fakeRpcLog)
      .filter((entry: any) => entry.sessionId === id && entry.message === "later-run");
    expect(commands.map((entry: any) => entry.type)).toEqual(["prompt"]);
  }, 20_000);

  test("runs /compact through RPC instead of recording a user prompt", async () => {
    const id = await createThread();
    const listed = await api("GET", `/v1/sessions/${id}/commands`);
    expect(listed.value.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "compact", source: "builtin" }),
    ]));
    const requestId = crypto.randomUUID();
    const result = await api("POST", `/v1/sessions/${id}/command`, { requestId, name: "compact" });
    expect(result).toMatchObject({ status: 202, value: { accepted: true, command: "compact" } });
    const rpcCommands = await waitFor(
      async () => readJsonLines(fakeRpcLog).filter((entry: any) => entry.sessionId === id),
      (entries) => entries.some((entry: any) => entry.type === "compact"),
    );
    expect(rpcCommands.some((entry: any) => entry.type === "compact")).toBe(true);
    const events = await api("GET", `/v1/sessions/${id}/events?after=0`);
    expect(events.value.events.some((event: any) => event.type === "user")).toBe(false);
    await api("DELETE", `/v1/sessions/${id}`);
  });

  test("reports compaction start and completion without retaining an unconfirmed old context", async () => {
    const id = await createThread();
    await api("PUT", `/v1/sessions/${id}/context`, {
      capturedAt: Date.now(),
      context: {
        systemPrompt: "old prompt",
        tools: [],
        messages: [{ role: "user", content: [{ type: "text", text: "removed by compaction" }] }],
      },
    });
    resetGate("compaction");
    await api("POST", `/v1/sessions/${id}/prompt`, { requestId: crypto.randomUUID(), text: "compact" });
    await waitForGate("compaction");
    try {
      const compacting = await waitFor(
        () => api("GET", "/v1/sessions").then((result) => result.value.sessions.find((session: any) => session.id === id)),
        (session) => session?.activity === "COMPACTING",
      );
      expect(compacting.activity).toBe("COMPACTING");
      const sync = await api("POST", "/v1/sync", {
        after: 0, waitMs: 0, includeSessions: false, includeDashboard: false, watchedIds: [id],
      });
      expect(sync.value.watched).toEqual([
        expect.objectContaining({ id, state: "RUNNING", activity: "COMPACTING" }),
      ]);
      const inProgressEvents = await api("GET", `/v1/sessions/${id}/events?after=0`);
      expect(inProgressEvents.value.events.some((event: any) => event.type === "settled")).toBe(false);
    } finally {
      releaseGate("compaction");
    }
    const events = await waitFor(
      () => api("GET", `/v1/sessions/${id}/events?after=0`).then((result) => result.value.events),
      (rows) => rows.some((event: any) => event.type === "notice" && event.text === "Context compacted"),
    );
    expect(events.filter((event: any) => event.type === "notice").map((event: any) => event.text))
      .toEqual(expect.arrayContaining(["Compacting context…", "Context compacted"]));
    const context = await api("GET", `/v1/sessions/${id}/context`);
    expect(context.value.context).toBeNull();
  }, 15_000);

  test("keeps the context replacement acknowledged during compaction", async () => {
    const id = await createThread();
    const futureCapture = Date.now() + 60_000;
    await api("PUT", `/v1/sessions/${id}/context`, {
      capturedAt: futureCapture,
      context: {
        systemPrompt: "old prompt",
        tools: [],
        messages: [{ role: "user", content: [{ type: "text", text: "removed by compaction" }] }],
      },
    });
    resetGate("compaction");
    await api("POST", `/v1/sessions/${id}/prompt`, { requestId: crypto.randomUUID(), text: "compact" });
    await waitForGate("compaction");
    try {
      await waitFor(
        () => api("GET", "/v1/sessions").then((result) => result.value.sessions.find((session: any) => session.id === id)),
        (session) => session?.activity === "COMPACTING",
      );
      const replacement = await api("PUT", `/v1/sessions/${id}/context`, {
        capturedAt: Date.now(),
        replacement: "compaction",
        context: {
          systemPrompt: "current prompt",
          tools: [],
          messages: [{ role: "user", content: [{ type: "text", text: "compacted summary" }] }],
        },
      });
      expect(replacement.value.capturedAt).toBeGreaterThan(futureCapture);
    } finally {
      releaseGate("compaction");
    }
    await waitFor(
      () => api("GET", `/v1/sessions/${id}/events?after=0`).then((result) => result.value.events),
      (events) => events.some((event: any) => event.type === "notice" && event.text === "Context compacted"),
    );
    const context = await api("GET", `/v1/sessions/${id}/context`);
    expect(context.value.context.messages[0].content[0].text).toBe("compacted summary");
  }, 15_000);

  test("surfaces a terminal model refusal instead of silently settling", async () => {
    const id = await createThread("home", "fable");
    await api("POST", `/v1/sessions/${id}/prompt`, { requestId: crypto.randomUUID(), text: "model-refusal" });
    const result = await waitFor(
      () => api("GET", `/v1/sessions/${id}/events?after=0`).then((response) => response.value),
      (value) => value.events.some((event: any) => event.type === "notice" && event.text.includes("Blocked by the provider policy")),
    );
    expect(result.events.some((event: any) => event.type === "notice" && event.text === "Model refused the message: Blocked by the provider policy")).toBe(true);
    expect(result.events.some((event: any) => event.type === "assistant")).toBe(false);
    await waitFor(() => api("GET", `/v1/sessions/${id}`).then((response) => response.value.session), (session) => session?.state === "IDLE");
  }, 15_000);

  test("hides an account-limit failure when failover succeeds", async () => {
    const id = await createThread();
    await api("POST", `/v1/sessions/${id}/prompt`, { requestId: crypto.randomUUID(), text: "account-failover" });
    const result = await waitFor(
      () => api("GET", `/v1/sessions/${id}/events?after=0`).then((response) => response.value),
      (value) => value.session.state === "IDLE" && value.events.some(
        (event: any) => event.type === "assistant" && event.text === "continued on next account",
      ),
    );
    expect(result.events.some((event: any) => event.type === "notice" && event.text.includes("usage limit"))).toBe(false);
  }, 15_000);

  test("does not let a stale settled event complete a newly dispatched message", async () => {
    const id = await createThread();
    await api("POST", `/v1/sessions/${id}/prompt`, { requestId: crypto.randomUUID(), text: "stale-settled" });
    const events = await waitFor(
      () => api("GET", `/v1/sessions/${id}/events?after=0`).then((result) => result.value.events),
      (rows) => rows.some((event: any) => event.type === "assistant" && event.text === "done once"),
    );
    expect(events.some((event: any) => event.type === "notice" && event.text.includes("stale settled"))).toBe(true);
    const session = await waitFor(
      () => api("GET", `/v1/sessions/${id}`).then((result) => result.value.session),
      (value) => value?.state === "IDLE",
    );
    expect(session.activity).toBe("IDLE");
  }, 15_000);

  test("does not let inactive reconciliation settle the prompt-to-agent_start gap", async () => {
    const id = await createThread();
    resetGate("delayed-start");
    const accepted = await api("POST", `/v1/sessions/${id}/prompt`, {
      requestId: crypto.randomUUID(), text: "delayed-start",
    });
    expect(accepted.value.session).toMatchObject({ steeringQueued: 0, followUpQueued: 0 });
    expect(accepted.value.session.revision).toBeGreaterThan(0);
    await waitForGate("delayed-start");
    const duringGap = await api("GET", `/v1/sessions/${id}`);
    expect(duringGap.value.session).toMatchObject({ state: "RUNNING", activity: "QUEUED" });
    const ledger = new Database(join(root, "data", "supervisor.sqlite3"), { readonly: true });
    const workDuringGap = ledger.query("SELECT state FROM work_items WHERE session_id=? ORDER BY event_seq DESC LIMIT 1").get(id) as any;
    ledger.close();
    expect(workDuringGap.state).toBe("dispatched");
    releaseGate("delayed-start");
    const events = await waitFor(
      () => api("GET", `/v1/sessions/${id}/events?after=0`).then((result) => result.value),
      (value) => value.session.state === "IDLE" &&
        value.events.some((event: any) => event.type === "assistant" && event.text === "started after reconcile"),
    );
    expect(events.session.state).toBe("IDLE");
    expect(events.session.revision).toBeGreaterThanOrEqual(accepted.value.session.revision);
  }, 15_000);

  test("aborting during activation cannot resurrect queued work", async () => {
    const created = await api("POST", "/v1/sessions", { requestId: crypto.randomUUID(), destination: "home" });
    const id = created.value.session.id;
    await api("POST", `/v1/sessions/${id}/prompt`, { requestId: crypto.randomUUID(), text: "must not launch" });
    const aborted = await api("POST", `/v1/sessions/${id}/abort`, {});
    expect(aborted.value).toMatchObject({ ok: true, retainedQueued: 0 });
    const stopped = await waitFor(
      () => api("GET", `/v1/sessions/${id}`).then((result) => result.value.session),
      (session) => session.state === "IDLE",
    );
    expect(stopped.activity).toBe("IDLE");
    await Bun.sleep(30);
    const ledger = new Database(join(root, "data", "supervisor.sqlite3"), { readonly: true });
    const work = ledger.query("SELECT state FROM work_items WHERE session_id=? ORDER BY event_seq DESC LIMIT 1").get(id) as any;
    ledger.close();
    expect(work.state).toBe("cancelled");
    const commands = readJsonLines(fakeRpcLog);
    expect(commands.some((entry: any) => entry.sessionId === id && entry.type === "prompt")).toBe(false);
  }, 15_000);

  test("abort cancels a queued prompt that is waiting to retry", async () => {
    const id = await createThread();
    const runtimePid = JSON.parse(readFileSync(fakeLaunch, "utf8")).pid;
    await api("POST", `/v1/sessions/${id}/prompt`, { requestId: crypto.randomUUID(), text: "retry-prompt" });
    const retrying = await waitFor(
      () => api("GET", `/v1/sessions/${id}`).then((result) => result.value.session),
      (session) => session.activity === "RETRYING",
    );
    expect(retrying.state).toBe("RUNNING");

    const aborted = await api("POST", `/v1/sessions/${id}/abort`, {});
    expect(aborted).toMatchObject({ status: 200, value: { ok: true, retainedQueued: 0 } });
    expect(aborted.value.session).toMatchObject({ state: "IDLE", activity: "IDLE" });
    expect(JSON.parse(readFileSync(fakeLaunch, "utf8")).pid).toBe(runtimePid);

    const ledger = new Database(join(root, "data", "supervisor.sqlite3"), { readonly: true });
    const work = ledger.query("SELECT state,last_error FROM work_items WHERE session_id=? ORDER BY created_at DESC LIMIT 1").get(id) as any;
    ledger.close();
    expect(work).toEqual({ state: "cancelled", last_error: "Current turn stopped by user" });
  }, 15_000);

  test("monitors a lost prompt acknowledgement without resending", async () => {
    const id = await createThread();
    resetGate("ack-timeout");
    await api("POST", `/v1/sessions/${id}/prompt`, { requestId: crypto.randomUUID(), text: "ack-timeout" });
    await waitForGate("ack-timeout");
    try {
      await waitFor(
        () => api("GET", `/v1/sessions/${id}/events?after=0`).then((result) => result.value.events),
        (rows) => rows.some((event: any) => event.type === "notice" && event.text.includes("without resending")),
      );
    } finally {
      releaseGate("ack-timeout");
    }
    const events = await waitFor(
      () => api("GET", `/v1/sessions/${id}/events?after=0`).then((result) => result.value.events),
      (rows) => rows.some((event: any) => event.type === "assistant" && event.text === "ack was lost"),
    );
    expect(events.filter((event: any) => event.type === "user" && event.text === "ack-timeout")).toHaveLength(1);
    expect(events.some((event: any) => event.type === "notice" && event.text.includes("without resending"))).toBe(true);
    await waitFor(() => api("GET", `/v1/sessions/${id}`).then((result) => result.value.session), (value) => value?.state === "IDLE");
    const ledger = new Database(join(root, "data", "supervisor.sqlite3"), { readonly: true });
    const work = ledger.query("SELECT state,attempts FROM work_items WHERE session_id=?").get(id) as any;
    ledger.close();
    expect(work).toMatchObject({ state: "complete", attempts: 0 });
  }, 15_000);

  test("repairs a missing settled event after abort", async () => {
    const id = await createThread();
    await api("POST", `/v1/sessions/${id}/prompt`, { requestId: crypto.randomUUID(), text: "abort-no-settle" });
    await waitFor(() => api("GET", `/v1/sessions/${id}`).then((result) => result.value.session), (session) => session?.state === "RUNNING");
    const aborted = await api("POST", `/v1/sessions/${id}/abort`, {});
    expect(aborted).toMatchObject({ status: 200, value: { ok: true } });
    const session = await api("GET", `/v1/sessions/${id}`);
    expect(session.value.session).toMatchObject({ state: "IDLE", activity: "IDLE" });
  }, 15_000);

  test("abort stops the active tool without terminating the agent process", async () => {
    const id = await createThread();
    const runtimePid = JSON.parse(readFileSync(fakeLaunch, "utf8")).pid;
    rmSync(fakeChildPid, { force: true });
    await api("POST", `/v1/sessions/${id}/prompt`, { requestId: crypto.randomUUID(), text: "group-child" });
    const childPid = await waitFor(
      async () => existsSync(fakeChildPid) ? Number(readFileSync(fakeChildPid, "utf8")) : 0,
      (pid) => pid > 1,
    );
    await api("POST", `/v1/sessions/${id}/prompt`, {
      requestId: crypto.randomUUID(), text: "later-run", delivery: "followUp",
    });
    const stopped = await api("POST", `/v1/sessions/${id}/abort`, {});
    expect(stopped).toMatchObject({ status: 200, value: { ok: true, retainedQueued: 1 } });
    await waitFor(
      async () => {
        try { process.kill(childPid, 0); return false; } catch { return true; }
      },
      Boolean,
    );
    await waitFor(
      () => api("GET", `/v1/sessions/${id}/events?after=0`).then((result) => result.value),
      (value) => value.events.some((event: any) => event.type === "assistant" && event.text === "later ran"),
    );
    const completed = await waitFor(
      () => api("GET", `/v1/sessions/${id}`).then((result) => result.value.session),
      (session) => session?.state === "IDLE",
    );
    expect(completed).toMatchObject({ state: "IDLE", followUpQueued: 0 });
    expect(JSON.parse(readFileSync(fakeLaunch, "utf8")).pid).toBe(runtimePid);
    const ledger = new Database(join(root, "data", "supervisor.sqlite3"), { readonly: true });
    const work = ledger.query("SELECT text,state FROM work_items WHERE session_id=? ORDER BY created_at,rowid").all(id) as any[];
    ledger.close();
    expect(work).toEqual([
      { text: "group-child", state: "cancelled" },
      { text: "later-run", state: "complete" },
    ]);
  }, 20_000);

  test("leaves the agent process running when Pi refuses an abort", async () => {
    const id = await createThread();
    const runtimePid = JSON.parse(readFileSync(fakeLaunch, "utf8")).pid;
    await api("POST", `/v1/sessions/${id}/prompt`, { requestId: crypto.randomUUID(), text: "abort-refuse" });
    await waitFor(() => api("GET", `/v1/sessions/${id}`).then((result) => result.value.session), (session) => session?.state === "RUNNING");
    const aborted = await api("POST", `/v1/sessions/${id}/abort`, {});
    expect(aborted).toMatchObject({ status: 409, value: { error: expect.stringContaining("still running") } });
    const session = await api("GET", `/v1/sessions/${id}`);
    expect(session.value.session.state).toBe("RUNNING");
    expect(JSON.parse(readFileSync(fakeLaunch, "utf8")).pid).toBe(runtimePid);
    await api("DELETE", `/v1/sessions/${id}`);
  }, 20_000);

  test("an unexpected active child exit resumes without exposing FAILED", async () => {
    const id = await createThread();
    await api("POST", `/v1/sessions/${id}/prompt`, { requestId: crypto.randomUUID(), text: "crash-once" });
    let sawFailed = false;
    const events = await waitFor(
      async () => {
        const session = await api("GET", `/v1/sessions/${id}`);
        if (session.value.session.state === "FAILED") sawFailed = true;
        return api("GET", `/v1/sessions/${id}/events?after=0`).then((result) => result.value);
      },
      (value) => value.events.some((event: any) => event.type === "assistant" && event.text === "recovered after disconnect"),
      15_000,
    );
    expect(sawFailed).toBe(false);
    await waitFor(
      () => api("GET", `/v1/sessions/${id}`).then((result) => result.value.session),
      (session) => session?.state === "IDLE",
    );
    expect(events.events.some((event: any) => event.type === "notice" && event.text.includes("Agent disconnected (exit 17)"))).toBe(true);
    expect(events.events.some((event: any) => event.type === "notice" && event.text === "Agent process failed")).toBe(false);
    expect(events.events.filter((event: any) => event.type === "user" && event.text === "crash-once")).toHaveLength(1);
    const recoveryCommands = readJsonLines(fakeRpcLog)
      .filter((entry: any) => entry.sessionId === id && entry.type === "prompt");
    expect(recoveryCommands).toHaveLength(2);
    expect(recoveryCommands[1].message).toContain("Continue the unfinished work");
    expect(recoveryCommands[1].message).toContain("USER: crash-once");
  }, 20_000);

  test("a replaced supervisor cannot publish late child-exit state", async () => {
    const id = await createThread();
    await api("POST", `/v1/sessions/${id}/prompt`, { requestId: crypto.randomUUID(), text: "lease-exit" });
    const ledger = new Database(join(root, "data", "supervisor.sqlite3"));
    ledger.exec("PRAGMA busy_timeout=5000");
    const epoch = String((ledger.query("SELECT value FROM metadata WHERE key='supervisor_epoch'").get() as any).value);
    try {
      ledger.query("UPDATE metadata SET value='replacement-test' WHERE key='supervisor_epoch'").run();
      await Bun.sleep(50);
      const row = ledger.query("SELECT state,last_error FROM sessions WHERE id=?").get(id) as any;
      expect(row.state).toBe("RUNNING");
      expect(row.last_error).toBe(null);
      const failureNotices = Number((ledger.query(
        "SELECT COUNT(*) count FROM events WHERE session_id=? AND type='notice' AND payload LIKE '%Agent process failed%'",
      ).get(id) as any).count);
      expect(failureNotices).toBe(0);
    } finally {
      ledger.query("UPDATE metadata SET value=? WHERE key='supervisor_epoch'").run(epoch);
      ledger.close();
    }
    const removed = await api("DELETE", `/v1/sessions/${id}`);
    expect(removed.status).toBe(200);
  }, 20_000);

  test("a replacement supervisor resumes active work exactly once", async () => {
    const id = await createThread();
    await api("POST", `/v1/sessions/${id}/prompt`, { requestId: crypto.randomUUID(), text: "restart-once" });
    await waitFor(
      () => api("GET", `/v1/sessions/${id}`).then((result) => result.value.session),
      (session) => session?.state === "RUNNING" && existsSync(fakeRestartMarker),
    );
    server.kill("SIGTERM");
    await server.exited;
    await startServer();
    const events = await waitFor(
      () => api("GET", `/v1/sessions/${id}/events?after=0`).then((result) => result.value),
      (value) => value.events.some((event: any) => event.type === "assistant" && event.text === "recovered after supervisor restart"),
      15_000,
    );
    await waitFor(
      () => api("GET", `/v1/sessions/${id}`).then((result) => result.value.session),
      (session) => session?.state === "IDLE",
    );
    expect(events.events.filter((event: any) => event.type === "user" && event.text === "restart-once")).toHaveLength(1);
    const ledger = new Database(join(root, "data", "supervisor.sqlite3"), { readonly: true });
    const work = ledger.query("SELECT state,resume,attempts FROM work_items WHERE session_id=? AND text='restart-once'").all(id) as any[];
    ledger.close();
    expect(work).toEqual([{ state: "complete", resume: 1, attempts: 0 }]);
    const prompts = readJsonLines(fakeRpcLog)
      .filter((entry: any) => entry.sessionId === id && entry.type === "prompt");
    expect(prompts).toHaveLength(2);
    expect(prompts[1].message).toContain("Continue the unfinished work");
  }, 20_000);

  test("release activation finishes an active turn before replacing its runtime", async () => {
    const id = await createThread();
    resetGate("release-later");
    await api("POST", `/v1/sessions/${id}/prompt`, { requestId: crypto.randomUUID(), text: "release-later" });
    await waitForGate("release-later");
    const runtimePid = Number(JSON.parse(readFileSync(fakeLaunch, "utf8")).pid);
    server.kill("SIGHUP");
    expect(await server.exited).toBe(75);
    expect(() => process.kill(runtimePid, 0)).not.toThrow();

    await startServer();
    releaseGate("release-later");
    const events = await waitFor(
      () => api("GET", `/v1/sessions/${id}/events?after=0`).then((result) => result.value),
      (value) => value.events.some((event: any) => event.type === "assistant" && event.text === "current finished"),
    );
    // The retired runtime stops on its own chain of asynchronous steps: the
    // turn settles, the supervisor asks the host to terminate, the host signals
    // the child, and the child exits. Locally that lands in under a second, but
    // a loaded CI runner has twice spent longer than the default eight-second
    // wait and failed the whole release gate on scheduling rather than on
    // behaviour. The assertion is that the old process really goes away, so
    // give it room to be slow while still failing if it never goes.
    await waitFor(
      async () => {
        try { process.kill(runtimePid, 0); return false; }
        catch { return true; }
      },
      (stopped) => stopped,
      30_000,
    );
    const settings = await api("GET", `/v1/sessions/${id}/settings`);
    expect(settings.status).toBe(200);
    expect(Number(JSON.parse(readFileSync(fakeLaunch, "utf8")).pid)).not.toBe(runtimePid);
    const ledger = new Database(join(root, "data", "supervisor.sqlite3"), { readonly: true });
    const work = ledger.query("SELECT state,resume FROM work_items WHERE session_id=? AND text='release-later'").get(id) as any;
    ledger.close();
    expect(work).toEqual({ state: "complete", resume: 0 });
    expect(readJsonLines(fakeRpcLog).filter((entry: any) => entry.sessionId === id && entry.type === "abort")).toHaveLength(0);
    expect(readJsonLines(fakeRpcLog).filter((entry: any) => entry.sessionId === id && entry.type === "prompt")).toHaveLength(1);
  }, 60_000);
});
