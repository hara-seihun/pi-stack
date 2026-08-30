import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test as bunTest } from "bun:test";
import { Database } from "bun:sqlite";
import { OrchestratorClient } from "pi-orchestrator/api";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  return { status: response.status, value };
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
      PI_REMOTE_AUDIO_BIN: fakeAudio,
      PI_FAKE_AUDIO_STATE: fakeAudioState,
      PI_REMOTE_DATA: join(root, "data"),
      PI_REMOTE_PORT: String(port),
      PI_AGENT_DIR: join(root, "agent"),
      PI_REMOTE_PROMPT_ACK_TIMEOUT_MS: "100",
      PI_REMOTE_STATE_RECONCILE_MS: "5",
      PI_REMOTE_RUNTIME_CONNECT_TIMEOUT_MS: "200",
      PI_REMOTE_RUNTIME_START_TIMEOUT_MS: "500",
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
model_id = sys.argv[sys.argv.index('--model') + 1] if '--model' in sys.argv else 'claude-fable-5'
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
   {'provider':'anthropic','id':'claude-fable-5','name':'Claude Fable 5'},
   {'provider':'anthropic-2','id':'claude-fable-5','name':'Claude Fable 5 (#2)'},
   {'provider':'anthropic-3','id':'claude-fable-5','name':'Claude Fable 5 (#3)'},
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
   if last == 'release-later':
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
 if os.path.exists(state_path):
  with open(state_path) as state: print(state.read())
 else: print(json.dumps({'status':'stopped'}))
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
  `);
  const insertRun = orchestrator.query(`INSERT INTO run
    (id,task_id,tier,account_id,state,started_at,provider,model)
    VALUES(?,?,\"standard\",\"openai-codex\",?,0,\"openai-codex\",?)`);
  for (let index = 0; index < 122; index++) insertRun.run(`sol-${index}`, "sol-task", "running", "openai-codex/gpt-5.6-sol");
  insertRun.run("opus-mixed", "sol-task", "running", "anthropic/claude-opus-5");
  for (let index = 0; index < 45; index++) insertRun.run(`luna-${index}`, "luna-task", "running", "openai-codex/gpt-5.6-luna");
  for (let index = 0; index < 4; index++) insertRun.run(`pro-${index}`, "pro-task", "running", "chatgpt-pro/gpt-5-6-pro-literal");
  insertRun.run("grok", "grok-task", "running", "cursor/grok-4.6");
  insertRun.run("finished", "luna-task", "done", "openai-codex/gpt-5.6-luna");
  orchestrator.query(`UPDATE run SET started_at=1000,provider='openai-codex-3',thinking='xhigh',team_role='supervisor',team_slot=0
    WHERE id='sol-0'`).run();
  orchestrator.query(`UPDATE run SET team_role='worker',team_slot=1 WHERE id='sol-1'`).run();
  orchestrator.query(`UPDATE run SET started_at=500,ended_at=900,provider='openai-codex-2',thinking='max'
    WHERE id='finished'`).run();
  orchestrator.close();
  mkdirSync(join(fakeAgentRuns, "sol-0"), { recursive: true });
  writeFileSync(join(fakeAgentRuns, "sol-0", "events.jsonl"), [
    { seq: 1, time: "2026-08-18T00:00:00.000Z", type: "user", payload: { text: "claim one unit" } },
    { seq: 2, time: "2026-08-18T00:00:02.000Z", type: "tool_start", payload: { toolCallId: "t1", name: "bash", args: { command: "ls" } } },
    { seq: 3, time: "2026-08-18T00:00:03.000Z", type: "tool_end", payload: { toolCallId: "t1", name: "bash", output: "ledger.sqlite3", error: false } },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n");
  writeFileSync(join(fakeAgentRuns, "sol-0", "live.json"), JSON.stringify({ activity: "THINKING", liveText: "", liveThinking: "weighing options" }));
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
  test("toggles the machine thunder ambience", async () => {
    const initial = await api("GET", "/v1/audio/thunder");
    expect(initial).toMatchObject({ status: 200, value: { thunder: { active: false, status: "stopped" } } });

    const started = await api("POST", "/v1/audio/thunder/toggle", {});
    expect(started).toMatchObject({ status: 200, value: { thunder: { active: true, status: "playing" } } });
    expect((await api("GET", "/v1/audio/thunder")).value.thunder.active).toBe(true);

    const stopped = await api("POST", "/v1/audio/thunder/toggle", {});
    expect(stopped).toMatchObject({ status: 200, value: { thunder: { active: false, status: "stopped" } } });
  });

  test("reports this host's load for the drawer footer", async () => {
    const usage = await api("GET", "/v1/machine");
    expect(usage.status).toBe(200);
    const machine = usage.value.machine;
    // A single read cannot yet know CPU or GPU load, so those may be null until
    // a later sample; memory and disk are always present.
    expect(machine.cpuPercent === null || typeof machine.cpuPercent === "number").toBe(true);
    expect(machine.gpuPercent === null || typeof machine.gpuPercent === "number").toBe(true);
    expect(machine.memory).toMatchObject({ usedBytes: expect.any(Number), totalBytes: expect.any(Number), percentUsed: expect.any(Number) });
    expect(machine.disk).toMatchObject({ usedBytes: expect.any(Number), totalBytes: expect.any(Number), percentUsed: expect.any(Number) });
  });

  test("cycles a provider's allowance through off, green, blue, and a red halt", async () => {
    const initial = await api("GET", "/v1/governor-controls");
    expect(initial.status).toBe(200);
    expect(initial.value.governors).toMatchObject({
      openai: { state: "off", boosted: false, multiplier: 1 },
      anthropic: { state: "off", boosted: false, multiplier: 1 },
    });

    // The cycle itself comes from the orchestrator package (BOOST_CYCLE), so
    // this asserts the drawer walks those states rather than a second copy.
    const green = await api("POST", "/v1/governor-controls/openai/toggle", {});
    expect(green.status).toBe(200);
    expect(green.value.governors.openai).toMatchObject({ state: "green", boosted: true, multiplier: 3 });
    // Anthropic is a separate family and is unaffected.
    expect(green.value.governors.anthropic).toMatchObject({ state: "off", boosted: false, multiplier: 1 });

    const blue = await api("POST", "/v1/governor-controls/openai/toggle", {});
    expect(blue.value.governors.openai).toMatchObject({ state: "blue", boosted: true, multiplier: BOOSTED_MULTIPLIER });

    // Red is the halt: multiplier 0, which the orchestrator's broker reads as
    // "launch nothing new for this family".
    const red = await api("POST", "/v1/governor-controls/openai/toggle", {});
    expect(red.value.governors.openai).toMatchObject({ state: "red", boosted: false, multiplier: 0 });

    // The orchestrator's own ledger row is the only state: the halt is
    // durable and visible to the controller, not supervisor memory.
    const ledger = new Database(fakeOrchestratorDb, { readonly: true, strict: true });
    expect(ledger.query("SELECT value FROM control WHERE key='boost:openai-codex'").get()).toMatchObject({ value: "0" });
    ledger.close();

    expect((await api("GET", "/v1/sessions")).value.governors.openai).toMatchObject({ state: "red", multiplier: 0 });
    const restored = await api("POST", "/v1/governor-controls/openai/toggle", {});
    expect(restored.value.governors.openai).toMatchObject({ state: "off", boosted: false, multiplier: 1 });
  });

  test("voice pool is the orchestrator ledger intersected with auth custody", async () => {
    const status = await api("GET", "/v1/voice");
    expect(status.status).toBe(200);
    expect(status.value).toEqual({ enabled: true, accountCount: 1, model: "gpt-live-1-codex", voice: "cove" });
  });

  test("reports this machine's active model counts", async () => {
    const listed = await api("GET", "/v1/sessions");
    expect(listed.value.agents).toMatchObject({
      total: 173,
      sources: { piRemote: 0, orchestrator: 173 },
      groups: [
        { key: "pi-remote", label: "REMOTE", count: 0 },
        { key: "orchestrator", label: "ORCH", count: 173 },
        { key: "sol", label: "SOL", count: 122 },
        { key: "luna", label: "LUNA", count: 45 },
        { key: "pro", label: "PRO", count: 4 },
        { key: "opus", label: "OPUS", count: 1 },
        { key: "grok", label: "GROK", count: 1 },
      ],
      models: [
        { key: "sol", label: "SOL", count: 122 },
        { key: "luna", label: "LUNA", count: 45 },
        { key: "pro", label: "PRO", count: 4 },
        { key: "opus", label: "OPUS", count: 1 },
        { key: "grok", label: "GROK", count: 1 },
      ],
      locations: [{ key: "local", label: "THIS MACHINE", name: "This machine", total: 173, models: [
        { key: "sol", label: "SOL", count: 122 },
        { key: "luna", label: "LUNA", count: 45 },
        { key: "pro", label: "PRO", count: 4 },
        { key: "opus", label: "OPUS", count: 1 },
        { key: "grok", label: "GROK", count: 1 },
      ], error: null }],
    });
  });

  test("lists this host's working agents for observation", async () => {
    const listed = await api("GET", "/v1/agents/runs");
    expect(listed.status).toBe(200);
    expect(listed.value.running).toBe(173);
    expect(listed.value.hosts).toEqual([
      { key: "local", label: "THIS MACHINE", name: "This machine", running: 173, updatedAt: expect.any(String), error: null },
    ]);
    const observable = listed.value.runs.find((run: any) => run.id === "local:sol-0");
    expect(observable).toMatchObject({
      host: "local", hostName: "This machine", runId: "sol-0",
      taskId: "sol-task", status: "running", label: "SOL", provider: "openai-codex-3",
      thinking: "xhigh", teamRole: "supervisor", teamSlot: 0,
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

    // Watching a live agent asks its host to publish partial output.
    expect(Date.now() - statSync(join(fakeAgentRuns, "sol-0", "watch")).mtimeMs).toBeLessThan(10_000);

    expect((await api("GET", "/v1/agents/runs/local:sol-0/events?after=3")).value.events).toEqual([]);
    expect((await api("GET", "/v1/agents/runs/local:missing-run/events")).status).toBe(404);
    expect((await api("GET", "/v1/agents/runs/local:%2E%2E%2Fescape/events")).status).toBe(400);
    expect((await api("GET", "/v1/agents/runs/nowhere:sol-0/events")).status).toBe(400);
    expect((await api("GET", "/v1/agents/runs/sol-0/events")).status).toBe(400);
    expect((await api("POST", "/v1/agents/runs/local:sol-0/events", {})).status).toBe(404);
  });

  test("merges working Pi Remote runtimes with hosted agents", async () => {
    const id = await createThread("home", "sol");
    await api("POST", `/v1/sessions/${id}/prompt`, {
      requestId: crypto.randomUUID(), text: "hold-queue", delivery: "followUp",
    });
    const agents = await waitFor(
      () => api("GET", "/v1/sessions").then((result) => result.value.agents),
      (value) => value?.sources?.piRemote === 1,
    );
    expect(agents).toMatchObject({
      total: 174,
      sources: { piRemote: 1, orchestrator: 173 },
      groups: [
        { key: "pi-remote", label: "REMOTE", count: 1 },
        { key: "orchestrator", label: "ORCH", count: 173 },
        { key: "sol", label: "SOL", count: 123 },
        { key: "luna", label: "LUNA", count: 45 },
        { key: "pro", label: "PRO", count: 4 },
        { key: "opus", label: "OPUS", count: 1 },
        { key: "grok", label: "GROK", count: 1 },
      ],
    });
    await api("POST", `/v1/sessions/${id}/abort`, {});
    await api("DELETE", `/v1/sessions/${id}`);
  });

  test("archives and unarchives a thread without deleting its history", async () => {
    const id = await createThread();
    await api("POST", `/v1/sessions/${id}/prompt`, {
      requestId: crypto.randomUUID(), text: "slow-ack-auto", delivery: "followUp",
    });
    await waitFor(
      () => api("GET", `/v1/sessions/${id}/events?after=0`).then((result) => result.value),
      (result) => result.events.some((event: any) => event.type === "assistant" && event.text === "slow ack done"),
    );

    const archived = await api("DELETE", `/v1/sessions/${id}`);
    expect(archived).toMatchObject({ status: 200, value: { ok: true, archived: true, session: { id } } });
    const afterArchive = await api("GET", "/v1/sessions");
    expect(afterArchive.value.sessions.some((session: any) => session.id === id)).toBe(false);
    expect(afterArchive.value.archivedSessions.some((session: any) => session.id === id)).toBe(true);
    const preserved = await api("GET", `/v1/sessions/${id}/events?after=0`);
    expect(preserved.value.events.some((event: any) => event.type === "assistant" && event.text === "slow ack done")).toBe(true);
    const blocked = await api("POST", `/v1/sessions/${id}/prompt`, {
      requestId: crypto.randomUUID(), text: "must-not-run",
    });
    expect(blocked).toMatchObject({ status: 409, value: { error: expect.stringContaining("archived") } });

    const restored = await api("POST", `/v1/sessions/${id}/unarchive`, {});
    expect(restored).toMatchObject({ status: 200, value: { ok: true, session: { id, archivedAt: null } } });
    const afterRestore = await api("GET", "/v1/sessions");
    expect(afterRestore.value.sessions.some((session: any) => session.id === id)).toBe(true);
    expect(afterRestore.value.archivedSessions.some((session: any) => session.id === id)).toBe(false);
    await api("DELETE", `/v1/sessions/${id}`);
  });

  test("lists only the newest archived page and pages older archived threads on request", async () => {
    const ledger = new Database(join(root, "data", "supervisor.sqlite3"));
    ledger.exec("PRAGMA busy_timeout=5000");
    const seeded = Array.from({ length: 25 }, (_, index) => ({
      id: crypto.randomUUID(),
      name: `Archived ${String(index).padStart(2, "0")}`,
      archivedAt: `2099-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
    }));
    const baseline = (await api("GET", "/v1/sessions")).value.archivedTotal as number;
    try {
      for (const row of seeded) {
        ledger.query(`
          INSERT INTO sessions(id,name,workspace_id,session_path,state,created_at,updated_at,archived_at,
            initial_provider,current_provider,initial_model,initial_thinking,profile_id)
          VALUES(?,?,'openai',NULL,'STOPPED',?,?,?,'openai','openai','gpt-5.1-codex-max','high','home')
        `).run(row.id, row.name, row.archivedAt, row.archivedAt, row.archivedAt);
      }
      const listed = await api("GET", "/v1/sessions");
      expect(listed.value.archivedSessions).toHaveLength(20);
      expect(listed.value.archivedTotal).toBe(baseline + 25);
      expect(listed.value.archivedSessions[0].name).toBe("Archived 24");
      expect(listed.value.archivedSessions.at(-1).name).toBe("Archived 05");

      const older = await api("GET", "/v1/sessions/archived?offset=20&limit=20");
      expect(older.status).toBe(200);
      expect(older.value).toMatchObject({ total: baseline + 25, offset: 20, limit: 20, hasMore: baseline + 25 > 40 });
      expect(older.value.sessions).toHaveLength(Math.min(20, baseline + 5));
      expect(older.value.sessions.slice(0, 5).map((session: any) => session.name))
        .toEqual(["Archived 04", "Archived 03", "Archived 02", "Archived 01", "Archived 00"]);

      const firstPage = await api("GET", "/v1/sessions/archived?offset=0&limit=5");
      expect(firstPage.value).toMatchObject({ total: baseline + 25, offset: 0, limit: 5, hasMore: true });
      expect(firstPage.value.sessions.map((session: any) => session.name))
        .toEqual(["Archived 24", "Archived 23", "Archived 22", "Archived 21", "Archived 20"]);

      const clamped = await api("GET", "/v1/sessions/archived?offset=-5&limit=999");
      expect(clamped.value).toMatchObject({ offset: 0, limit: 100, hasMore: baseline + 25 > 100 });
      expect(clamped.value.sessions).toHaveLength(Math.min(100, baseline + 25));
    } finally {
      for (const row of seeded) ledger.query("DELETE FROM sessions WHERE id=?").run(row.id);
      ledger.close();
    }
  });

  test("permits the shared native shell to call the API", async () => {
    const preflight = await fetch(base + "/v1/sync", {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("http://localhost");
    expect(preflight.headers.get("access-control-allow-methods")).toContain("POST");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("content-type");

    const health = await fetch(base + "/v1/health", { headers: { origin: "http://localhost" } });
    expect(health.status).toBe(200);
    expect(health.headers.get("access-control-allow-origin")).toBe("http://localhost");
  });

  test("serves the browser interface and local assets", async () => {
    const page = await fetch(base + "/");
    expect(page.headers.get("content-type")).toContain("text/html");
    const markup = await page.text();
    expect(markup).toContain("id=\"conversation\"");
    expect(markup).not.toContain("id=\"agent-summary\"");
    expect(markup).not.toContain("id=\"local-agent-summary\"");
    expect(markup).toContain("id=\"plan-summary\"");
    expect(markup).not.toContain("id=\"openai-plan\"");
    expect(markup).not.toContain("id=\"anthropic-plan\"");
    expect(markup).not.toContain("id=\"cursor-plan\"");
    expect(markup).toContain("id=\"usage-summary\"");
    expect(markup).toContain("id=\"thunder-control\"");
    expect(markup).toContain("id=\"openai-governor-control\"");
    expect(markup).toContain("id=\"anthropic-governor-control\"");
    expect(markup).toContain("CPU — · GPU — · RAM — · DISK —");
    // The thread starters are built from /v1/thread-starts, so the page carries the row and
    // no destination or model of its own.
    expect(markup).toContain("id=\"new-thread-buttons\"");
    expect(markup).not.toContain("new-openai-thread");
    expect(markup).not.toContain("new-converge-thread");
    expect(markup).toContain("id=\"connection\" class=\"connection muted\" hidden");
    expect(markup).toContain("id=\"attachments\"");
    expect(markup).toContain("id=\"file-picker\"");
    expect(markup).toContain("id=\"message-queue\"");
    expect(markup).toContain("id=\"queue-status\"");
    expect(markup).toContain("id=\"speed-select\"");
    expect(markup).toContain("src=\"/vendor/pi-markdown-compat.js\"");
    expect(markup).toContain("src=\"/native.js\"");
    expect(markup).toContain("id=\"native-environment\"");
    expect(markup).not.toContain("id=\"toast-region\"");
    expect(markup).not.toContain("id=\"steer\"");
    expect(markup).not.toContain("id=\"follow-up\"");
    expect(markup).not.toContain("id=\"abort\"");
    expect(markup).not.toContain("id=\"process-page\"");
    expect(markup).not.toContain("id=\"machine-usage\"");
    expect(markup).toContain("id=\"paste-text\"");
    expect(markup).toContain("id=\"paste-text-dialog\"");
    expect(markup).toContain("Paste text document");
    const referencedAssets = [...markup.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((match) => match[1]);
    for (const asset of new Set(referencedAssets)) {
      const response = await fetch(`${base}${asset}`);
      expect(response.status, `missing browser asset ${asset}`).toBe(200);
    }
    for (const icon of ["openai", "opus", "sol", "fable", "house", "anthropic", "cursor", "personal", "work", "converge", "thunder"]) {
      const response = await fetch(`${base}/${icon}.svg`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("image/svg+xml");
      expect(await response.text()).toContain("<svg");
    }
    const styles = await fetch(base + "/styles.css");
    const css = await styles.text();
    expect(css).toContain("gap: 0; padding: 0; background: var(--surface)");
    expect(css).toContain("margin: 0 8px 0 12px");
    expect(css).toContain("margin: 0 12px 0 8px");
    expect(css).toContain(".topbar > .icon-button { flex: 0 0 48px; height: 56px; margin: 0; }");
    expect(css).toContain(".thread-provider { flex: 0 0 14px;");
    expect(css).toContain(".machine-controls { height: 44px; display: grid; grid-template-columns: repeat(3, 1fr);");
    expect(css).toContain(".machine-control.active { background: var(--tool-ok); }");
    expect(css).toContain(".capacity-row { min-width: 0; display: grid;");
    expect(css).toContain(".archive-thread { position: absolute; z-index: 1; top: 4px; right: 5px;");
    expect(css).toContain(".composer { flex: 0 0 auto; display: grid; gap: 2px;");
    expect(css).not.toContain("grid-template-rows: auto auto 40px");
    expect(css).not.toContain(".toast");
    const nativeScript = await fetch(base + "/native.js");
    expect(nativeScript.headers.get("content-type")).toContain("text/javascript");
    expect(await nativeScript.text()).toContain('capacitor.registerPlugin("KenanRemote")');
    const script = await fetch(base + "/app.js");
    expect(script.headers.get("content-type")).toContain("text/javascript");
    const source = await script.text();
    expect(source).not.toContain("renderProcesses");
    expect(source).toContain("renderMarkdown");
    expect(source).toContain("modelContextEntries");
    expect(source).toContain('fetch("/v1/sync"');
    expect(source).toContain('contextProjection: "display"');
    expect(source).toContain("window.PiRemoteSync.update");
    expect(source).toContain('if (metric.text === "—") continue;');
    expect(source).not.toContain('api("GET", `/v1/sessions/${requested}/context`)');
    expect(source).not.toContain('api("GET", `/v1/sessions/${requested}/events?after=${after}`)');
    expect(source).not.toContain("setInterval(poll");
    expect(source).not.toContain("function toast");
    expect(source).toContain("pi-remote-file");
    expect(source).toContain("/files?path=");
    expect(source).toContain("uploadFiles");
    expect(source).toContain("openPasteTextDialog");
    expect(source).toContain("Archived threads");
    expect(source).toContain('node("button", "archive-thread", "×")');
    expect(source).toContain('open.addEventListener("click", () => { selectThread(session); closeDrawer(); });');
    expect(source).not.toContain("installArchiveSlide");
    expect(source).not.toContain('addEventListener("pointermove"');
    expect(source).not.toContain("archiveGestureActive");
    expect(source).toContain("unarchiveThread");
    expect(source).not.toContain("deleteThread");
    expect(source).not.toContain("confirm(`Archive thread");
    expect(source).toContain("pastedTextFileName");
    expect(source).toContain('type: "text/plain;charset=utf-8"');
    expect(source).toContain("The following files were attached to this message:");
    expect(source).toContain("renderAgents");
    expect(source).toContain("updateUsageSummary");
    expect(source).toContain("Array.isArray(plans?.cards)");
    expect(source).toContain("metric.description");
    expect(source).toContain("state.agentModelCounts.get(metric.model)");
    expect(source).toContain("encodeURIComponent(card.icon)");
    expect(source).not.toContain("fablePaceDelta");
    expect(source).not.toContain("opusPaceDelta");
    expect(source).toContain("renderGovernorControls(all.governors)");
    expect(source).toContain('api("POST", `/v1/governor-controls/${provider}/toggle`, {})');
    expect(source).toContain('api("POST", "/v1/audio/thunder/toggle", {})');
    expect(source).toContain("GPU ${gpu}");
    expect(source).toContain("localStorage.setItem");
    expect(source).toContain("loadDraft(session.id)");
    expect(source).toContain("nearConversationBottom");
    expect(source).toContain("if (!state.followTail) return");
    expect(source).not.toContain('plan.percentLeft <= 15 ? "var(--danger)"');
    expect(source).toContain('providerIcon.src = `/${provider}.svg`');
    expect(source).toContain('const starts = await api("GET", "/v1/thread-starts");');
    expect(source).toContain('["dollars", "brackets", "beg_end"]');
    expect(source).toContain("window.normalizeLatexDelimiters");
    const markdownCompat = await fetch(base + "/vendor/pi-markdown-compat.js");
    expect(markdownCompat.headers.get("content-type")).toContain("text/javascript");
    expect(await markdownCompat.text()).toContain("normalizeLatexDelimiters");
    expect(source).toContain('event.key === "Enter" && !event.shiftKey && !event.isComposing');
    expect(source).toContain('updateSettings({ speedMode: ui.speed.value })');
    expect(source).toContain("state.attachments.some((file) => file.path)");
    expect(source).not.toContain('sendPrompt("steer")');
    expect(source).toContain('sendPrompt("followUp")');
    expect(source).toContain("steerQueuedMessage");
    expect(source).toContain("cancelQueuedMessage");
    expect(source).toContain("restoreQueuedDraft(result.text ?? message.text)");
    expect(source).toContain('"STEER"');
    expect(source).toContain('"EDIT"');
    expect(source).toContain('"CANCEL"');
    expect(source).toContain("selectedRevision");
    expect(source).toContain("selectionEpoch");
    expect(source).toContain("pollAgain");
    expect(source).toContain("pendingActions");
    const katex = await fetch(base + "/vendor/katex.min.js");
    expect(katex.headers.get("content-type")).toContain("text/javascript");
    expect((await katex.text()).length).toBeGreaterThan(100_000);
    const font = await fetch(base + "/vendor/katex/fonts/KaTeX_Main-Regular.woff2");
    expect(font.headers.get("content-type")).toBe("font/woff2");
    expect((await font.arrayBuffer()).byteLength).toBeGreaterThan(10_000);
  });

  test("stores attached files in ingestion and removes discarded uploads", async () => {
    const upload = await fetch(`${base}/v1/uploads?name=${encodeURIComponent("notes.txt")}`, {
      method: "POST", headers: { "content-type": "text/plain" }, body: "attached content",
    });
    expect(upload.status).toBe(201);
    const first = (await upload.json() as any).file;
    expect(first).toMatchObject({ name: "notes.txt", size: 16, path: join(root, "ingestion", "notes.txt") });
    expect(readFileSync(first.path, "utf8")).toBe("attached content");

    const duplicate = await fetch(`${base}/v1/uploads?name=${encodeURIComponent("notes.txt")}`, {
      method: "POST", body: "second",
    });
    const second = (await duplicate.json() as any).file;
    expect(second.name).toBe("notes-2.txt");
    const removed = await fetch(`${base}/v1/uploads?name=${encodeURIComponent(first.name)}`, { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect(existsSync(first.path)).toBe(false);
  });

  test("initializes a numeric thread once through the lifecycle extension", async () => {
    const id = await createThread("home", "sol");
    const before = await api("GET", `/v1/sessions/${id}`);
    expect(before.value.session.provider).toBe("openai");
    const initialNumber = Number(before.value.session.name);
    const launch = JSON.parse(readFileSync(fakeLaunch, "utf8"));
    expect(launch.sessionId).toBe(id);
    expect(launch.serverUrl).toBe(base);
    expect(launch.argv).not.toContain("--append-system-prompt");
    expect(launch.argv).toEqual(expect.arrayContaining([
      "--extension", join(import.meta.dir, "service-tier.ts"),
      "--extension", join(import.meta.dir, "thread-context.ts"),
    ]));
    expect(launch.argv).not.toContain(join(import.meta.dir, "context-mirror.ts"));
    expect(readFileSync(launch.serviceTierFile, "utf8").trim()).toBe("priority");
    expect(launch.argv).toEqual(expect.arrayContaining([
      "--provider", "openai-codex", "--model", "gpt-5.6-sol", "--thinking", "high",
    ]));
    expect(initialNumber).toBeGreaterThan(0);

    const initialized = await fetch(`${base}/v1/sessions/${id}/name`, { method: "PUT", body: "Markdown Rendering" });
    expect(initialized.status).toBe(200);
    expect(await initialized.json()).toEqual({ ok: true, name: "Markdown Rendering" });

    const renamed = await api("GET", `/v1/sessions/${id}`);
    expect(renamed.value.session.name).toBe("Markdown Rendering");
    const same = await fetch(`${base}/v1/sessions/${id}/name`, { method: "PUT", body: "Markdown Rendering" });
    expect(same.status).toBe(200);
    const secondRename = await fetch(`${base}/v1/sessions/${id}/name`, { method: "PUT", body: "Different Title" });
    expect(secondRename.status).toBe(409);

    const nextId = await createThread();
    const next = await api("GET", `/v1/sessions/${nextId}`);
    expect(Number(next.value.session.name)).toBeGreaterThan(initialNumber);
    const nextLaunch = JSON.parse(readFileSync(fakeLaunch, "utf8"));
    expect(readFileSync(nextLaunch.serviceTierFile, "utf8").trim()).toBe("default");
    const invalid = await fetch(`${base}/v1/sessions/${nextId}/name`, { method: "PUT", body: "One" });
    expect(invalid.status).toBe(400);
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

  test("creates Opus threads with Claude Opus 5 and high thinking", async () => {
    const id = await createThread("home", "opus");
    const listed = await api("GET", "/v1/sessions");
    expect(listed.value.sessions.find((session: any) => session.id === id)?.provider).toBe("anthropic");
    const launch = JSON.parse(readFileSync(fakeLaunch, "utf8"));
    expect(launch.sessionId).toBe(id);
    expect(launch.argv).toEqual(expect.arrayContaining([
      "--provider", "anthropic", "--model", "claude-opus-5", "--thinking", "high",
    ]));
  });

  test("creates Anthropic threads with Claude Fable 5 and high thinking", async () => {
    const id = await createThread("home", "fable");
    const listed = await api("GET", "/v1/sessions");
    expect(listed.value.sessions.find((session: any) => session.id === id)?.provider).toBe("anthropic");
    const launch = JSON.parse(readFileSync(fakeLaunch, "utf8"));
    expect(launch.sessionId).toBe(id);
    expect(launch.argv).toEqual(expect.arrayContaining([
      "--provider", "anthropic", "--model", "claude-fable-5", "--thinking", "high",
    ]));
    const invalid = await api("POST", "/v1/sessions", { requestId: crypto.randomUUID(), destination: "unknown" });
    expect(invalid).toMatchObject({ status: 400, value: { error: "Unknown thread destination" } });
  });

  test("creates Personal sessions in Private with Claude Fable 5 and low thinking", async () => {
    const id = await createThread("personal", "fable");
    const listed = await api("GET", "/v1/sessions");
    const session = listed.value.sessions.find((candidate: any) => candidate.id === id);
    expect(session).toMatchObject({
      environment: "personal",
      workspaceName: "Private",
      cwd: join(root, "private"),
      provider: "anthropic",
    });
    const launch = JSON.parse(readFileSync(fakeLaunch, "utf8"));
    expect(launch.argv).toEqual(expect.arrayContaining([
      "--provider", "anthropic", "--model", "claude-fable-5", "--thinking", "low",
    ]));
  });

  test("lists the host filesystem from root and downloads files without a preview endpoint", async () => {
    const browser = join(root, "file-browser");
    mkdirSync(join(browser, ".hidden"), { recursive: true });
    mkdirSync(join(browser, "folder"));
    writeFileSync(join(browser, "file10.txt"), "ten");
    writeFileSync(join(browser, "file2.txt"), "two");

    const listed = await api("GET", `/v1/files?path=${encodeURIComponent(browser)}`);
    expect(listed).toMatchObject({
      status: 200,
      value: {
        directory: {
          path: browser,
          parent: root,
          entries: [
            { name: ".hidden", path: join(browser, ".hidden"), kind: "directory" },
            { name: "folder", path: join(browser, "folder"), kind: "directory" },
            { name: "file2.txt", path: join(browser, "file2.txt"), kind: "file" },
            { name: "file10.txt", path: join(browser, "file10.txt"), kind: "file" },
          ],
        },
      },
    });

    const rootListing = await api("GET", "/v1/files?path=%2F");
    expect(rootListing.status).toBe(200);
    expect(rootListing.value.directory.path).toBe("/");
    expect(rootListing.value.directory.parent).toBeNull();
    expect(rootListing.value.directory.entries.some((entry: any) => entry.path === resolve(tmpdir()))).toBe(true);

    const download = await fetch(`${base}/v1/files/download?path=${encodeURIComponent(join(browser, "file2.txt"))}`);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain('filename="file2.txt"');
    expect(await download.text()).toBe("two");

    const range = await fetch(`${base}/v1/files/download?path=${encodeURIComponent(join(browser, "file10.txt"))}`, {
      headers: { range: "bytes=1-2" },
    });
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe("bytes 1-2/3");
    expect(await range.text()).toBe("en");

    expect((await api("GET", "/v1/files?path=relative")).status).toBe(400);
    expect((await api("GET", `/v1/files?path=${encodeURIComponent(join(browser, "missing"))}`)).status).toBe(404);
    expect((await fetch(`${base}/v1/files/download?path=relative`)).status).toBe(400);
  });

  test("downloads files from a thread's local workspace", async () => {
    const localId = await createThread("home", "sol");
    const localPath = join(root, "download report.txt");
    writeFileSync(localPath, "local report");
    try {
      const local = await fetch(`${base}/v1/sessions/${localId}/files?path=${encodeURIComponent(localPath)}`);
      expect(local.status).toBe(200);
      expect(local.headers.get("content-type")).toContain("text/plain");
      expect(local.headers.get("content-disposition")).toContain('filename="download report.txt"');
      expect(local.headers.get("content-disposition")).toContain("filename*=UTF-8''download%20report.txt");
      expect(await local.text()).toBe("local report");

      const head = await fetch(`${base}/v1/sessions/${localId}/files?path=${encodeURIComponent(localPath)}`, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.headers.get("content-length")).toBe(String("local report".length));
      expect(await head.text()).toBe("");

      const relative = await fetch(`${base}/v1/sessions/${localId}/files?path=report.txt`);
      expect(relative.status).toBe(400);
      const missing = await fetch(`${base}/v1/sessions/${localId}/files?path=${encodeURIComponent(join(root, "missing.txt"))}`);
      expect(missing.status).toBe(404);
      const unknown = await fetch(`${base}/v1/sessions/00000000-0000-0000-0000-000000000000/files?path=${encodeURIComponent(localPath)}`);
      expect(unknown.status).toBe(404);
    } finally { rmSync(localPath, { force: true }); }
  });

  test("describes the server identity and its profiles", async () => {
    const metadata = await api("GET", "/v1/environment");
    expect(metadata.status).toBe(200);
    expect(metadata.value.environment).toEqual({
      id: "local",
      name: "Local",
      requiresUnlock: true,
      capabilities: { voice: true, downloads: true, notifications: true, files: true },
      profiles: expect.arrayContaining([
        expect.objectContaining({ id: "personal" }),
        expect.objectContaining({ id: "home" }),
      ]),
    });
    const health = await api("GET", "/v1/health");
    expect(health.value.environmentId).toBe("local");
    expect(health.value.version).toBe(JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8")).version);
  });

  test("offers each destination only the models it can actually run", async () => {
    const starts = await api("GET", "/v1/thread-starts");
    const destinations = starts.value.destinations;
    // Rarest first: the menu grows toward the button, so the everyday choice lands under
    // the finger. Home then Opus is two taps in one place.
    expect(destinations.map((entry: any) => entry.id)).toEqual(["personal", "home"]);
    expect(destinations[1].models.map((model: any) => model.id)).toEqual(["sol", "fable", "opus"]);
    expect(destinations[0].models.map((model: any) => model.id)).toEqual(["sol", "opus", "fable"]);
  });

  test("every choice names a glyph the shared client can draw", async () => {
    const source = join(import.meta.dir, "..");
    const starts = await api("GET", "/v1/thread-starts");
    const icons = starts.value.destinations.flatMap((entry: any) => [entry.icon, ...entry.models.map((model: any) => model.icon)]);
    expect(icons.length).toBeGreaterThan(0);
    for (const icon of icons) expect(existsSync(join(source, "web", `${icon}.svg`))).toBe(true);
  });

  test("rolls account aliases into common and uncommon model groups", async () => {
    const id = await createThread("home", "sol");
    const result = await api("GET", `/v1/sessions/${id}/settings`);
    expect(result.status).toBe(200);
    expect(result.value.settings).toMatchObject({ speedMode: "priority", speedModes: ["normal", "priority"] });
    const normal = await api("PUT", `/v1/sessions/${id}/settings`, { speedMode: "normal" });
    expect(normal.status).toBe(200);
    expect(normal.value.settings.speedMode).toBe("normal");
    const priority = await api("PUT", `/v1/sessions/${id}/settings`, { speedMode: "priority" });
    expect(priority.status).toBe(200);
    expect(priority.value.settings.speedMode).toBe("priority");
    const speedLaunch = JSON.parse(readFileSync(fakeLaunch, "utf8"));
    expect(readFileSync(speedLaunch.serviceTierFile, "utf8").trim()).toBe("priority");
    const models = result.value.settings.models;
    expect(models.filter((model: any) => model.provider === "openai-codex" && model.id === "gpt-5.6-sol")).toHaveLength(1);
    expect(models.some((model: any) => /^(?:openai-codex|anthropic)-\d+$/.test(model.provider))).toBe(false);
    expect(models.filter((model: any) => model.provider === "anthropic" && model.id === "claude-fable-5")).toHaveLength(1);
    expect(models.filter((model: any) => model.provider === "anthropic" && model.id === "claude-opus-5")).toHaveLength(1);
    expect(models.filter((model: any) => model.common).map((model: any) => model.id)).toEqual([
      "claude-fable-5", "claude-opus-5", "gpt-5.6-luna", "gpt-5.6-sol",
    ]);
    expect(models.filter((model: any) => !model.common).map((model: any) => model.id)).toEqual([
      "claude-sonnet-4", "gpt-5.5",
    ]);
    const changed = await api("PUT", `/v1/sessions/${id}/settings`, {
      modelProvider: "anthropic", modelId: "claude-fable-5",
    });
    expect(changed.status).toBe(200);
    expect(changed.value.settings.speedModes).toEqual([]);
    const unavailable = await api("PUT", `/v1/sessions/${id}/settings`, { speedMode: "priority" });
    expect(unavailable).toMatchObject({ status: 409, value: { error: "Priority speed is available only for OpenAI threads" } });
    const listed = await api("GET", "/v1/sessions");
    expect(listed.value.sessions.find((session: any) => session.id === id)?.provider).toBe("anthropic");
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
