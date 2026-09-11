import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test as bunTest } from "bun:test";
import { Database } from "bun:sqlite";
import { OrchestratorClient } from "pi-orchestrator/api";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { applyContextSplice, contextSplice, messageFinalizationKey, sha256 } from "./sync";
const [shardIndex = 0, shardCount = 1] = (process.env.PI_REMOTE_TEST_SHARD ?? "0/1")
  .split("/").map(Number);
if (!Number.isSafeInteger(shardIndex) || !Number.isSafeInteger(shardCount)
  || shardIndex < 0 || shardCount < 1 || shardIndex >= shardCount) {
  throw new Error("PI_REMOTE_TEST_SHARD must be a zero-based INDEX/COUNT");
}
let testIndex = 0;
const test = (name: string, body: () => Promise<unknown> | void, timeout?: number) => {
  const selected = testIndex++ % shardCount === shardIndex;
  return selected ? bunTest(name, body, timeout) : bunTest.skip(name, body, timeout);
};

const root = mkdtempSync(join(tmpdir(), "pi-remote-state-test-"));
const fakePi = join(root, "fake-pi.py");
const fakeAudio = join(root, "fake-audio.py");
const fakeAudioState = join(root, "fake-audio-state.json");
const fakeLaunch = join(root, "fake-launch.json");
const fakeNamingLog = join(root, "fake-naming.jsonl");
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
let sharedRunnerFixture = false;
let startupEventsFixture = false;
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
    stderr: "inherit",
    env: {
      ...process.env,
      PATH: `${root}:${process.env.PATH ?? ""}`,
      PI_BIN: fakePi,
      PI_FAKE_STARTUP_EVENTS: startupEventsFixture ? "1" : "",
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
      PI_REMOTE_RUNTIME_DRIVER: sharedRunnerFixture ? "shared" : "command",
      PI_REMOTE_MAX_ACTIVE_RUNTIMES: sharedRunnerFixture ? "0" : "8",
      PI_FAKE_NAMING_LOG: fakeNamingLog,
      PI_FAKE_RPC_LOG: fakeRpcLog,
      PI_FAKE_CHILD_PID: fakeChildPid,
      PI_FAKE_CRASH_MARKER: fakeCrashMarker,
      PI_FAKE_RESTART_MARKER: fakeRestartMarker,
      PI_FAKE_GATE_ROOT: fakeGateRoot,
      PI_FAKE_TIME_SCALE: "0.05",
      PI_REMOTE_ORCHESTRATOR_DB: fakeOrchestratorDb,
      PI_ORCHESTRATOR_AUTH: join(root, "agent", "auth.json"),
      PI_REMOTE_ORCHESTRATOR_RUNS: fakeAgentRuns,
      PI_REMOTE_ENVIRONMENT_ID: "local",
      PI_REMOTE_ENVIRONMENT_NAME: "Local",
      PI_REMOTE_THREAD_NAMING_MODEL: "openai-codex-12/gpt-5.6-luna:low",
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
        { id: "personal", label: "PERSONAL", icon: "personal", accent: "#a371f7", workspaceId: "private", thinkingLevel: "low", models: ["astra", "opus", "fable"], defaultModel: "fable" },
        { id: "home", label: "HOME", icon: "house", accent: "#3fb950", workspaceId: "home", thinkingLevel: "high", models: ["astra", "fable", "opus"], defaultModel: "opus" },
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
if '--print' in sys.argv:
 transcript_path = next((arg[1:] for arg in sys.argv if arg.startswith('@')), '')
 transcript = open(transcript_path).read() if transcript_path else ''
 with open(os.environ['PI_FAKE_NAMING_LOG'], 'a+') as naming_log:
  naming_log.write(json.dumps({'argv': sys.argv}) + '\\n')
  naming_log.flush()
  naming_log.seek(0)
  attempt = sum(1 for line in naming_log if line.strip())
 if 'retry thread naming' in transcript and attempt == 1:
  print('This title has too many words')
 elif 'retry thread naming' in transcript:
  print('Retry Thread Name')
 else:
  print('Automatic Thread Name')
 sys.exit(0)
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
# Published by rename so a reader never catches a half-written launch record.
with open(os.environ['PI_FAKE_LAUNCH'] + '.writing', 'w') as launch:
 json.dump({'argv': sys.argv, 'pid': os.getpid(), 'sessionId': os.environ.get('PI_REMOTE_SESSION_ID'), 'subagentModel': os.environ.get('PI_SUBAGENT_MODEL'), 'serverUrl': os.environ.get('PI_REMOTE_SERVER_URL'), 'serviceTierFile': os.environ.get('PI_REMOTE_SERVICE_TIER_FILE'), 'bashTimeoutSeconds': os.environ.get('PI_REMOTE_BASH_TIMEOUT_MAX_SECONDS'), 'agentDir': os.environ.get('PI_CODING_AGENT_DIR'), 'offline': os.environ.get('PI_OFFLINE')}, launch)
os.replace(os.environ['PI_FAKE_LAUNCH'] + '.writing', os.environ['PI_FAKE_LAUNCH'])
streaming = False
compacting = False
last = ''
session_name = None
steering = []
follow_up = []
first_state = True
child = None
editable_entries = [
 {'type':'message','id':'edit-u1','parentId':None,'timestamp':'2026-09-02T00:00:00.000Z','message':{'role':'user','content':'keep this','timestamp':100}},
 {'type':'message','id':'edit-a1','parentId':'edit-u1','timestamp':'2026-09-02T00:00:01.000Z','message':{'role':'assistant','content':[{'type':'text','text':'keep reply'}],'timestamp':101}},
 {'type':'message','id':'edit-u2','parentId':'edit-a1','timestamp':'2026-09-02T00:00:02.000Z','message':{'role':'user','content':'edit this','timestamp':200}},
 {'type':'message','id':'edit-a2','parentId':'edit-u2','timestamp':'2026-09-02T00:00:03.000Z','message':{'role':'assistant','content':[{'type':'text','text':'remove reply'}],'timestamp':201}},
]
editable_leaf = 'edit-a2'
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
 if kind == 'get_entries':
  out({'type':'response','id':rid,'command':'get_entries','success':True,'data':{'entries':editable_entries,'leafId':editable_leaf}})
 elif kind == 'fork':
  selected = next((entry for entry in editable_entries if entry['id'] == request.get('entryId')), None)
  if not selected or selected.get('message', {}).get('role') != 'user':
   out({'type':'response','id':rid,'command':'fork','success':False,'error':'Invalid entry ID for forking'})
  else:
   target = selected.get('parentId')
   keep = []
   current = target
   by_id = {entry['id']:entry for entry in editable_entries}
   while current:
    keep.append(by_id[current]); current = by_id[current].get('parentId')
   editable_entries[:] = list(reversed(keep))
   editable_leaf = target
   content = selected['message'].get('content', '')
   text = content if isinstance(content, str) else ''.join(block.get('text', '') for block in content if block.get('type') == 'text')
   out({'type':'response','id':rid,'command':'fork','success':True,'data':{'text':text,'cancelled':False}})
 elif kind == 'get_state':
  if first_state:
   first_state = False
   pause(0.12)
   if os.environ.get('PI_FAKE_STARTUP_EVENTS'):
    streaming = True
    out({'type':'agent_start'})
  out({'type':'response','id':rid,'command':'get_state','success':True,'data':{'isStreaming':streaming,'isCompacting':compacting,'pendingMessageCount':len(steering)+len(follow_up),'messageCount':0,'thinkingLevel':thinking_level,'sessionFile':None,'sessionName':session_name,'model':{'provider':provider,'id':model_id,'name':model_id}}})
 elif kind == 'get_available_models':
  out({'type':'response','id':rid,'command':kind,'success':True,'data':{'models':[
   {'provider':'openai-codex-2','id':'gpt-6-astra','name':'GPT-6 Astra duplicate'},
   {'provider':'openai-codex','id':'gpt-6-astra','name':'GPT-6 Astra'},
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
    out({'type':'message_update','message':{'role':'assistant','content':[{'type':'thinking','thinking':'thinking now'}]},'assistantMessageEvent':{'type':'thinking_end','content':'thinking now'}})
    out({'type':'message_update','message':{'role':'assistant','content':[{'type':'text','text':'instant text'}]},'assistantMessageEvent':{'type':'text_delta','delta':'instant text'}})
    gate('live-stream-next')
    out({'type':'message_update','message':{'role':'assistant','content':[{'type':'text','text':'instant text second'}]},'assistantMessageEvent':{'type':'text_delta','delta':' second'}})
    gate('live-stream')
    out({'type':'message_end','message':{'role':'assistant','content':[{'type':'thinking','thinking':'thinking now'},{'type':'text','text':'instant text second'}]}})
    streaming = False
    out({'type':'agent_settled'})
   elif last == 'thinking-omitted':
    out({'type':'message_update','message':{'role':'assistant','content':[{'type':'thinking','thinking':'visible thought'}]},'assistantMessageEvent':{'type':'thinking_delta','delta':'visible thought'}})
    out({'type':'message_update','message':{'role':'assistant','content':[{'type':'thinking','thinking':'visible thought'}]},'assistantMessageEvent':{'type':'thinking_end','content':'visible thought'}})
    gate('thinking-omitted')
    out({'type':'message_end','message':{'role':'assistant','content':[{'type':'thinking','thinking':''},{'type':'text','text':'done thinking'}]}})
    streaming = False
    out({'type':'agent_settled'})
   elif last == 'thinking-blocks':
    out({'type':'message_update','message':{'role':'assistant','content':[{'type':'thinking','thinking':''}]},'assistantMessageEvent':{'type':'thinking_start'}})
    out({'type':'message_update','message':{'role':'assistant','content':[{'type':'thinking','thinking':'first thought\\n\\n'}]},'assistantMessageEvent':{'type':'thinking_delta','delta':'first thought\\n\\n'}})
    out({'type':'message_update','message':{'role':'assistant','content':[{'type':'thinking','thinking':'first thought\\n\\n'}]},'assistantMessageEvent':{'type':'thinking_end','content':'first thought'}})
    out({'type':'message_update','message':{'role':'assistant','content':[{'type':'thinking','thinking':'first thought\\n\\n'}]},'assistantMessageEvent':{'type':'thinking_start'}})
    out({'type':'message_update','message':{'role':'assistant','content':[{'type':'thinking','thinking':'first thought\\n\\nsecond thought'}]},'assistantMessageEvent':{'type':'thinking_delta','delta':'second thought'}})
    out({'type':'message_update','message':{'role':'assistant','content':[{'type':'thinking','thinking':'first thought\\n\\nsecond thought'}]},'assistantMessageEvent':{'type':'thinking_end','content':'second thought'}})
    gate('thinking-blocks')
    out({'type':'message_end','message':{'role':'assistant','content':[{'type':'thinking','thinking':''},{'type':'text','text':'block answer'}]}})
    streaming = False
    out({'type':'agent_settled'})
   elif last == 'thinking-handoff':
    out({'type':'message_update','message':{'role':'assistant','content':[{'type':'thinking','thinking':'first message\\n\\n'}]},'assistantMessageEvent':{'type':'thinking_delta','delta':'first message\\n\\n'}})
    out({'type':'message_update','message':{'role':'assistant','content':[{'type':'thinking','thinking':'first message\\n\\n'}]},'assistantMessageEvent':{'type':'thinking_end','content':'first message'}})
    out({'type':'message_end','message':{'role':'assistant','content':[{'type':'thinking','thinking':'first message\\n\\n'},{'type':'text','text':'first answer'}]}})
    gate('thinking-handoff-next')
    out({'type':'message_update','message':{'role':'assistant','content':[{'type':'thinking','thinking':''}]},'assistantMessageEvent':{'type':'thinking_start'}})
    out({'type':'message_update','message':{'role':'assistant','content':[{'type':'thinking','thinking':'second message'}]},'assistantMessageEvent':{'type':'thinking_delta','delta':'second message'}})
    out({'type':'message_update','message':{'role':'assistant','content':[{'type':'thinking','thinking':'second message'}]},'assistantMessageEvent':{'type':'thinking_end','content':'second message'}})
    gate('thinking-handoff-current')
    out({'type':'message_end','message':{'role':'assistant','content':[{'type':'thinking','thinking':'second message'},{'type':'text','text':'second answer'}]}})
    streaming = False
    out({'type':'agent_settled'})
   elif last == 'release-later':
    threading.Thread(target=finish_release_later, daemon=True).start()
   elif last == 'hard-steer-now' or '<new_user_message>\\nhard-steer-now\\n</new_user_message>' in last:
    out({'type':'message_end','message':{'role':'assistant','content':[{'type':'text','text':'hard steer ran'}]}})
    streaming = False
    out({'type':'agent_settled'})
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
   elif 'delegate ' in last or '"type":"thread_result"' in last:
    out({'type':'message_end','message':{'role':'assistant','content':[{'type':'text','text':'done'}]}})
    streaming = False
    out({'type':'agent_settled'})
   elif last == 'retry thread naming':
    out({'type':'message_end','message':{'role':'assistant','content':[{'type':'text','text':'naming retry reply'}]}})
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
    gate('lease-exit')
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
  if '"type":"thread_result"' in request.get('message',''):
   steering.clear()
   out({'type':'queue_update','steering':steering,'followUp':follow_up})
   out({'type':'message_end','message':{'role':'assistant','content':[{'type':'text','text':'received steered result'}]}})
   if last != 'holding coordinator':
    streaming = False
    out({'type':'agent_settled'})
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
  `);
  const insertRun = orchestrator.query(`INSERT INTO run
    (id,source,source_id,prompt,cwd,profile,budget,account_id,state,created_at,updated_at,started_at,provider,model)
    VALUES(?,\"lane\",?,\"work\",\"/tmp\",\"standard\",\"background\",\"openai-codex\",?,0,0,0,\"openai-codex\",?)`);
  for (let index = 0; index < 122; index++) insertRun.run(`astra-${index}`, "astra-task", "running", "openai-codex/gpt-6-astra");
  insertRun.run("opus-mixed", "astra-task", "running", "anthropic/claude-opus-5");
  for (let index = 0; index < 45; index++) insertRun.run(`luna-${index}`, "luna-task", "running", "openai-codex/gpt-5.6-luna");
  insertRun.run("sonnet", "sonnet-task", "running", "anthropic/claude-sonnet");
  insertRun.run("finished", "luna-task", "done", "openai-codex/gpt-5.6-luna");
  const sessionFile = join(fakeAgentRuns, "astra-0.jsonl");
  orchestrator.query(`UPDATE run SET started_at=1000,provider='openai-codex-3',thinking='xhigh',session_file=?
    WHERE id='astra-0'`).run(sessionFile);
  orchestrator.query(`UPDATE run SET started_at=500,ended_at=900,provider='openai-codex-2',thinking='max'
    WHERE id='finished'`).run();
  orchestrator.query(`INSERT INTO live_state(run_id,activity,text,thinking,updated_at) VALUES('astra-0','THINKING','','weighing options',0)`).run();
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
  test("live events during activation are not cancellation and preserve RUNNING", async () => {
    server.kill(); await server.exited;
    startupEventsFixture = true;
    await startServer();
    let id: string | undefined;
    try {
      const created = await api("POST", "/v1/sessions", {requestId:crypto.randomUUID(),destination:"home",model:"astra"});
      expect(created.status).toBe(201); id = created.value.session.id;
      const read = () => api("GET", `/v1/sessions/${id}`).then(result=>result.value.session);
      await waitFor(read, session=>session?.state === "RUNNING" || session?.state === "FAILED");
      await Bun.sleep(100);
      const session = await read();
      expect(session.state).toBe("RUNNING");
      expect(session.lastError).toBeNull();
    } finally {
      if(id)await api("DELETE", `/v1/sessions/${id}`);
      server.kill(); await server.exited;
      startupEventsFixture=false; await startServer();
    }
  });

  test("capacity-blocked shared sessions remain QUEUED without revision churn and can be cancelled", async () => {
    server.kill(); await server.exited;
    sharedRunnerFixture = true;
    await startServer();
    let id: string | undefined;
    try {
      const created = await api("POST", "/v1/sessions", {requestId:crypto.randomUUID(),destination:"home",model:"astra"});
      expect(created.status).toBe(201); id = created.value.session.id;
      await api("POST", `/v1/sessions/${id}/prompt`, {requestId:crypto.randomUUID(),text:"capacity fixture"});
      const read = () => api("GET", `/v1/sessions/${id}`).then(result=>result.value.session);
      await waitFor(read, session=>session?.state==="QUEUED" && session?.lastError==="Waiting for shared runner capacity");
      await Bun.sleep(50);
      const before = await read();
      await Bun.sleep(2200);
      const after = await read();
      expect(after.state).toBe("QUEUED");
      expect(after.activity).toBe("QUEUED");
      expect(after.revision).toBe(before.revision);
      expect(after.queuedMessages[0].state).toBe("queued");
      const aborted = await api("POST", `/v1/sessions/${id}/abort`);
      expect(aborted.status).toBe(200);
      expect((await read()).state).toBe("STOPPED");
    } finally {
      if(id)await api("DELETE", `/v1/sessions/${id}`);
      server.kill();await server.exited;
      sharedRunnerFixture=false;await startServer();
    }
  });

  test("delegation pins models, reuses matching children and returns one durable result", async () => {
    const parentSessionId = await createThread("home", "astra");
    const requestId = crypto.randomUUID();
    const request = { requestId, parentSessionId, model: "luna", task: "delegate first task" };
    const created = await api("POST", "/v1/sessions", request);
    expect(created.status).toBe(201);
    const child = created.value.session.id;
    expect(created.value.session.subagent).toEqual({ parentSessionId, model: "gpt-5.6-luna" });
    const nested = await api("POST", "/v1/sessions", { requestId: crypto.randomUUID(), parentSessionId: child, task: "nested task", model: "astra" });
    expect(nested.status).toBe(403);
    expect(nested.value.error).toContain("Subagents cannot delegate");
    expect((await api("POST", "/v1/sessions", request)).value).toEqual(created.value);
    await waitFor(() => api("GET", `/v1/sessions/${parentSessionId}/events`).then((r) => r.value),
      (value) => value.events.some((e: any) => e.type === "user" && e.text.includes('"type":"thread_result"')));
    const settings = await api("PUT", `/v1/sessions/${child}/settings`, { modelProvider: "openai-codex", modelId: "gpt-6-astra" });
    expect(settings.status).toBe(409);
    expect(settings.value.error).toContain("immutable");
    const mismatch = await api("POST", "/v1/sessions", { ...request, requestId: crypto.randomUUID(), threadId: child, model: "astra" });
    expect(mismatch.status).toBe(409);
    const continued = await api("POST", "/v1/sessions", { ...request, requestId: crypto.randomUUID(), threadId: child, task: "delegate second task" });
    expect(continued.status).toBe(200);
    expect(continued.value.session.id).toBe(child);
    expect(continued.value.reused).toBe(true);
    const escalated = await api("POST", "/v1/sessions", { ...request, requestId: crypto.randomUUID(), model: "astra", task: "delegate escalated task" });
    expect(escalated.status).toBe(201);
    expect(escalated.value.session.id).not.toBe(child);
    expect(escalated.value.session.subagent.model).toBe("gpt-6-astra");
    const extraChildren: string[] = [];
    for (const model of ["sol", "terra"]) {
      const extra = await api("POST", "/v1/sessions", { ...request, requestId: crypto.randomUUID(), model, newThread: true, task: `delegate ${model} task` });
      expect(extra.status).toBe(201);
      expect(extra.value.session.subagent).toEqual({ parentSessionId, model: `gpt-5.6-${model}` });
      extraChildren.push(extra.value.session.id);
    }
    await waitFor(async () => {
      const ledger = new Database(join(root, "data", "supervisor.sqlite3"), { readonly: true });
      try { return ledger.query("SELECT reply_work_id FROM thread_delegations WHERE parent_session_id=?").all(parentSessionId) as any[]; }
      finally { ledger.close(); }
    }, (rows) => rows.length === 5 && rows.every((row) => row.reply_work_id));
    const ledger = new Database(join(root, "data", "supervisor.sqlite3"), { readonly: true });
    try {
      expect(ledger.query("SELECT count(*) AS n FROM work_items WHERE request_id=?").get(`thread-result-${created.value.delegation.workId}`)).toEqual({ n: 1 });
      expect(ledger.query("SELECT status,result FROM delegation_results WHERE work_id=?").get(created.value.delegation.workId)).toEqual({ status: "complete", result: "done" });
    } finally { ledger.close(); }
    await waitFor(() => api("GET", "/v1/sessions").then((r) => r.value.sessions),
      (sessions) => sessions.filter((s: any) => [parentSessionId, child, escalated.value.session.id, ...extraChildren].includes(s.id)).every((s: any) => s.state === "IDLE"));
    const finalMessage = { role: "assistant", content: [{ type: "text", text: "done" }] };
    await api("PUT", `/v1/sessions/${child}/context`, {
      capturedAt: Date.now(), context: { systemPrompt: "System", tools: [], messages: [finalMessage] },
      finalizesMessage: messageFinalizationKey(finalMessage),
    });
    await waitFor(() => api("GET", `/v1/sessions/${child}`).then(r => r.value.session), s => s.state === "STOPPED");
    expect((await api("GET", `/v1/sessions/${child}/context`)).value.context.messages).toEqual([finalMessage]);
    const resumed = await api("POST", "/v1/sessions", { ...request, requestId: crypto.randomUUID(), threadId: child, task: "delegate resumed task" });
    expect(resumed.status).toBe(200);
    expect(resumed.value.session.id).toBe(child);
  });
  test("replays idle transitions without requiring a selected thread or a connected client", async () => {
    const initial = await api("GET", "/v1/notifications");
    expect(initial.status).toBe(200);
    expect(initial.value.notifications).toEqual([]);
    const id = await createThread();
    expect((await api("GET", `/v1/notifications?after=${initial.value.cursor}`)).value.notifications).toEqual([]);
    await api("POST", `/v1/sessions/${id}/prompt`, { requestId: crypto.randomUUID(), text: "later-run" });
    const feed = await waitFor(() => api("GET", `/v1/notifications?after=${initial.value.cursor}`),
      (result) => result.value.notifications?.some((event: any) => event.sessionId === id));
    expect(feed.value.environmentId).toBe((await api("GET", "/v1/health")).value.environmentId);
    expect(feed.value.notifications.filter((event: any) => event.sessionId === id)).toHaveLength(1);
    expect((await api("GET", `/v1/notifications?after=${feed.value.cursor}`)).value.notifications).toEqual([]);
    expect((await api("GET", "/v1/notifications?after=-1")).status).toBe(400);
  });

  test("exposes host-configured actions as toggles it knows nothing about", async () => {
    const before = await api("POST", "/v1/sync", { seq: 0, dashboardVersion: 0, waitMs: 0 });
    expect(before.value.dashboard.actions).toEqual([{ id: "thunder", label: "Thunder", icon: "thunder", active: false }]);
    const on = await (await fetch(`${base}/v1/actions/thunder/toggle`, { method: "POST" })).json();
    expect(on.action.active).toBe(true);
    const woken = await api("POST", "/v1/sync", { epoch: before.value.epoch, seq: before.value.seq, dashboardVersion: before.value.dashboardVersion, waitMs: 5_000 });
    expect(woken.value.dashboard.actions[0].active).toBe(true);
    expect(woken.value.dashboardVersion).not.toBe(before.value.dashboardVersion);
    const off = await (await fetch(`${base}/v1/actions/thunder/toggle`, { method: "POST" })).json();
    expect(off.action.active).toBe(false);
    expect((await fetch(`${base}/v1/actions/nope/toggle`, { method: "POST" })).status).toBe(404);
  });

  test("wakes the dashboard when an allowance governor changes", async () => {
    const before = await api("POST", "/v1/sync", { seq: 0, dashboardVersion: 0, waitMs: 0 });
    const initial = before.value.dashboard.governors.openai.state;
    const toggled = await api("POST", "/v1/governor-controls/openai/toggle", {});
    expect(toggled.status).toBe(200);
    const woken = await api("POST", "/v1/sync", { epoch: before.value.epoch, seq: before.value.seq, dashboardVersion: before.value.dashboardVersion, waitMs: 5_000 });
    expect(woken.value.dashboard.governors.openai.state).not.toBe(initial);
    expect(woken.value.dashboard.governors.openai.state).toBe(toggled.value.governors.openai.state);
  });

  test("serves the compiled React client", async () => {
    const response = await fetch(base + "/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]);
    expect(assets.length).toBeGreaterThan(0);
    for (const path of assets) expect((await fetch(base + path)).status).toBe(200);
    expect((await fetch(base + "/voice.html")).status).toBe(200);
  });

  test("stores a bash timeout per thread and restarts its runtime with that limit", async () => {
    const id = await createThread();
    const before = await api("GET", `/v1/sessions/${id}/settings`);
    expect(before.value.settings.bashTimeoutSeconds).toBe(1800);
    const previousPid = Number(JSON.parse(readFileSync(fakeLaunch, "utf8")).pid);

    const updated = await api("PUT", `/v1/sessions/${id}/settings`, { bashTimeoutSeconds: 300 });
    expect(updated.status).toBe(200);
    expect(updated.value.settings.bashTimeoutSeconds).toBe(300);
    const launch = JSON.parse(readFileSync(fakeLaunch, "utf8"));
    expect(Number(launch.pid)).not.toBe(previousPid);
    expect(launch.bashTimeoutSeconds).toBe("300");

    const invalid = await api("PUT", `/v1/sessions/${id}/settings`, { bashTimeoutSeconds: 61 });
    expect(invalid.status).toBe(400);
    expect((await api("GET", `/v1/sessions/${id}/settings`)).value.settings.bashTimeoutSeconds).toBe(300);
  });

  test("persists a complete active thread order", async () => {
    await createThread("home", "astra");
    await createThread("home", "astra");
    const before = await api("GET", "/v1/sessions");
    const interactiveIds = (sessions: any[]) => sessions.filter((session) => !session.subagent).map((session) => session.id as string);
    const currentIds = interactiveIds(before.value.sessions);
    const requestedIds = [currentIds.at(-1)!, ...currentIds.slice(0, -1)];

    const reordered = await api("PUT", "/v1/sessions/order", { sessionIds: requestedIds });
    expect(reordered.status).toBe(200);
    expect(interactiveIds(reordered.value.sessions)).toEqual(requestedIds);
    expect(interactiveIds((await api("GET", "/v1/sessions")).value.sessions)).toEqual(requestedIds);

    const incomplete = await api("PUT", "/v1/sessions/order", { sessionIds: requestedIds.slice(1) });
    expect(incomplete).toMatchObject({ status: 409, value: { error: "Thread list changed; refresh before reordering" } });
    expect(interactiveIds((await api("GET", "/v1/sessions")).value.sessions)).toEqual(requestedIds);
  });

  test("names the first message through a configured tool-free Pi model", async () => {
    rmSync(fakeNamingLog, { force: true });
    const id = await createThread("home", "astra");
    const before = await api("POST", "/v1/sync", { seq: 0, stateVersion: 0, waitMs: 0 });
    await api("POST", `/v1/sessions/${id}/prompt`, { requestId: crypto.randomUUID(), text: "name this conversation" });
    const renamed = await waitFor(
      () => api("GET", "/v1/sessions").then((result) => result.value.sessions.find((session: any) => session.id === id)),
      (session) => session?.name === "Automatic Thread Name",
    );
    expect(renamed.revision).toBeGreaterThan(0);
    const invocation = readJsonLines(fakeNamingLog).at(-1);
    expect(invocation.argv).toContain("--print");
    expect(invocation.argv).toContain("--no-tools");
    expect(invocation.argv).toContain("openai-codex-12/gpt-5.6-luna:low");
    expect(invocation.argv.some((argument: string) => argument.startsWith("@") && argument.endsWith("/messages.txt"))).toBe(true);

    const reconciled = await api("POST", "/v1/sync", {
      seq: before.value.seq,
      stateVersion: before.value.stateVersion,
      epoch: before.value.epoch,
      waitMs: 25_000,
    });
    expect(reconciled.value.state.sessions.find((session: any) => session.id === id)?.name).toBe("Automatic Thread Name");
  });

  test("retries a malformed first title after the assistant reply", async () => {
    rmSync(fakeNamingLog, { force: true });
    const id = await createThread("home", "astra");
    await api("POST", `/v1/sessions/${id}/prompt`, { requestId: crypto.randomUUID(), text: "retry thread naming" });
    const renamed = await waitFor(
      () => api("GET", "/v1/sessions").then((result) => result.value.sessions.find((session: any) => session.id === id)),
      (session) => session?.name === "Retry Thread Name",
    );
    expect(renamed.name).toBe("Retry Thread Name");
    expect(readJsonLines(fakeNamingLog)).toHaveLength(2);
  });

  test("lists this host's working agents for observation", async () => {
    const listed = await api("GET", "/v1/agents/runs");
    expect(listed.status).toBe(200);
    expect(listed.value.running).toBe(169);
    expect(listed.value.hosts).toEqual([
      { key: "local", label: "THIS MACHINE", name: "This machine", running: 169, updatedAt: expect.any(String), error: null },
    ]);
    const observable = listed.value.runs.find((run: any) => run.id === "local:astra-0");
    expect(observable).toMatchObject({
      host: "local", hostName: "This machine", runId: "astra-0",
      taskId: "astra-task", status: "running", label: "ASTRA", provider: "openai-codex-3",
      thinking: "xhigh",
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
    const first = await api("GET", "/v1/agents/runs/local:astra-0/events");
    expect(first.status).toBe(200);
    expect(first.value.events.map((event: any) => event.type)).toEqual(["user", "tool_start", "tool_end"]);
    expect(first.value.events[0].text).toBe("claim one unit");
    expect(first.value.events[2]).toMatchObject({ toolCallId: "t1", name: "bash", output: "ledger.sqlite3", error: false });
    expect(first.value.liveThinking).toBe("weighing options");
    expect(first.value.run).toMatchObject({ id: "local:astra-0", taskId: "astra-task", activity: "THINKING" });

    expect((await api("GET", "/v1/agents/runs/local:astra-0/events?after=3")).value.events).toEqual([]);
    expect((await api("GET", "/v1/agents/runs/local:missing-run/events")).status).toBe(404);
    expect((await api("GET", "/v1/agents/runs/local:%2E%2E%2Fescape/events")).status).toBe(400);
    expect((await api("GET", "/v1/agents/runs/nowhere:astra-0/events")).status).toBe(400);
    expect((await api("GET", "/v1/agents/runs/astra-0/events")).status).toBe(400);
    expect((await api("POST", "/v1/agents/runs/local:astra-0/events", {})).status).toBe(404);
  });

  test("serves Pi's provider-neutral context as the entire interactive transcript", async () => {
    const id = await createThread("home", "astra");
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
    const id = await createThread("home", "astra");
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
      body: JSON.stringify({ seq: 0, waitMs: 0, session: { id, contextHash: "" } }),
    });
    expect(firstResponse.headers.get("content-encoding")).toBe("gzip");
    const first = await firstResponse.json() as any;
    expect(first.state).toBeNull();
    expect(first.dashboard).toBeNull();
    expect(first.session.context.kind).toBe("full");
    const displayDocument = JSON.parse(first.session.context.document);
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
    expect((await api("GET", `/v1/sessions/${id}/context`)).value.context).toEqual(firstContext);

    const unchanged = await api("POST", "/v1/sync", { seq: first.seq, waitMs: 0, session: { id, contextHash: first.session.context.hash } });
    expect(unchanged.value.session.context).toBeNull();

    const secondContext = { ...firstContext, messages: [{ role: "assistant", content: [{ type: "text", text: "first and second" }] }] };
    const baseDocument = JSON.stringify(firstContext);
    const targetDocument = JSON.stringify(secondContext);
    await api("PATCH", `/v1/sessions/${id}/context`, {
      capturedAt: 301,
      splice: contextSplice(baseDocument, targetDocument),
    });
    const second = await api("POST", "/v1/sync", { seq: first.seq, waitMs: 0, session: { id, contextHash: first.session.context.hash } });
    expect(second.value.session.context.kind).toBe("splice");
    const displayed = applyContextSplice(first.session.context.document, second.value.session.context.splice);
    expect(JSON.parse(displayed).messages).toEqual([{ role: "assistant", content: [{ type: "text", text: "first and second" }] }]);
  });

  test("loads transcript images separately without changing canonical context", async () => {
    const id = await createThread("home", "astra");
    const data = Buffer.alloc(1024 * 1024, 42).toString("base64");
    const context = { systemPrompt: "system", tools: [], messages: [{ role: "toolResult", content: [{ type: "image", mimeType: "image/png", data }] }] };
    await api("PUT", `/v1/sessions/${id}/context`, { capturedAt: 450, context });
    const sync = await api("POST", "/v1/sync", { waitMs: 0, session: { id } });
    const document = sync.value.session.context.document;
    expect(document.length).toBeLessThan(500);
    const image = JSON.parse(document).messages[0].content[0];
    expect(image.data).toBeUndefined();
    const response = await fetch(base + image.src);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await response.arrayBuffer()).toString("base64")).toBe(data);
    const cached = await fetch(base + image.src, { headers: { "if-none-match": response.headers.get("etag")! } });
    expect(cached.status).toBe(304);
    expect((await api("GET", `/v1/sessions/${id}/context`)).value.context).toEqual(context);
  });

  test("delivers a newly selected context while live text keeps waking the poll", async () => {
    const streaming = await createThread("home", "astra");
    const idle = await createThread("home", "astra");
    const idleContext = { systemPrompt: "quiet", tools: [], messages: [{ role: "assistant", content: [{ type: "text", text: "done earlier" }] }] };
    await api("PUT", `/v1/sessions/${idle}/context`, { capturedAt: 500, context: idleContext });
    resetGate("live-stream-next");
    resetGate("live-stream");
    try {
      await api("POST", `/v1/sessions/${streaming}/prompt`, { requestId: crypto.randomUUID(), text: "live-stream" });
      await waitForGate("live-stream-next");
      const caughtUp = await api("POST", "/v1/sync", { seq: 0, stateVersion: 0, waitMs: 0, session: { id: streaming } });
      releaseGate("live-stream-next");
      await waitForGate("live-stream");
      const switched = await api("POST", "/v1/sync", {
        epoch: caughtUp.value.epoch,
        seq: caughtUp.value.seq,
        stateVersion: caughtUp.value.stateVersion,
        waitMs: 0,
        session: { id: idle },
      });
      expect(switched.value.session.context).toMatchObject({ kind: "full" });
      expect(JSON.parse(switched.value.session.context.document).messages).toEqual(idleContext.messages);
    } finally {
      releaseGate("live-stream-next");
      releaseGate("live-stream");
    }
  });

  test("an idle selection ignores another thread's token wakes", async () => {
    const streaming = await createThread("home", "astra");
    const idle = await createThread("home", "astra");
    resetGate("live-stream-next");
    resetGate("live-stream");
    try {
      await api("POST", `/v1/sessions/${streaming}/prompt`, { requestId: crypto.randomUUID(), text: "live-stream" });
      await waitForGate("live-stream-next");
      const first = (await api("POST", "/v1/sync", { waitMs: 0, session: { id: idle } })).value;
      const started = Date.now();
      const waiting = api("POST", "/v1/sync", {
        epoch: first.epoch, seq: first.seq, waitMs: 150,
        session: { id: idle, liveTextHash: first.session.liveText.hash, liveThinkingHash: first.session.liveThinking.hash },
      });
      releaseGate("live-stream-next");
      await waitForGate("live-stream");
      const result = await waiting;
      expect(Date.now() - started).toBeGreaterThanOrEqual(130);
      expect(result.value.session.liveText).toBeNull();
      expect(result.value.session.liveThinking).toBeNull();
    } finally { releaseGate("live-stream-next"); releaseGate("live-stream"); }
  });

  test("publishes live model text without rebuilding unchanged application state", async () => {
    const id = await createThread("home", "astra");
    resetGate("live-stream-next");
    resetGate("live-stream");
    try {
      await api("POST", `/v1/sessions/${id}/prompt`, { requestId: crypto.randomUUID(), text: "live-stream" });
      await waitForGate("live-stream-next");
      await waitFor(
        () => api("GET", "/v1/sessions").then((result) => result.value.sessions.find((session: any) => session.id === id)),
        (session) => session?.name === "Automatic Thread Name",
      );
      const first = await waitFor(() => api("POST", "/v1/sync", {
        seq: 0,
        stateVersion: 0,
        waitMs: 0,
        session: { id },
      }), (result) => result.value.session?.liveText?.document === "instant text");
      expect(first.value.session.liveText).toMatchObject({ kind: "full", document: "instant text" });
      expect(first.value.session.liveThinking).toMatchObject({ kind: "full", document: "thinking now" });

      releaseGate("live-stream-next");
      await waitForGate("live-stream");
      const second = await waitFor(() => api("POST", "/v1/sync", {
        seq: first.value.seq,
        stateVersion: first.value.stateVersion,
        epoch: first.value.epoch,
        waitMs: 1_000,
        session: { id, liveTextHash: first.value.session.liveText.hash, liveThinkingHash: first.value.session.liveThinking.hash },
      }), (result) => Boolean(result.value.session?.liveText));
      expect(second.value.state).toBeNull();
      expect(second.value.session.context).toEqual({ kind: "clear", capturedAt: 0, hash: "" });
      expect(second.value.stateVersion).toBe(first.value.stateVersion);
      expect(applyContextSplice("instant text", second.value.session.liveText.splice)).toBe("instant text second");

      releaseGate("live-stream");
      await waitFor(async () => (await api("GET", `/v1/sessions/${id}/events?after=0`)).value, (value) => value.session.state === "IDLE");
      const beforeContext = await api("GET", `/v1/sessions/${id}/events?after=0`);
      expect(beforeContext.value.liveText).toBe("instant text second");
      expect(beforeContext.value.liveThinking).toBe("thinking now");
      expect(beforeContext.value.events.filter((event: any) => event.type === "thinking")).toHaveLength(1);

      const finalMessage = { role: "assistant", content: [{ type: "thinking", thinking: "thinking now" }, { type: "text", text: "instant text second" }] };
      await api("PUT", `/v1/sessions/${id}/context`, {
        capturedAt: 400,
        context: { systemPrompt: "System", tools: [], messages: [finalMessage] },
        finalizesMessage: messageFinalizationKey(finalMessage),
      });
      const afterContext = await api("GET", `/v1/sessions/${id}/events?after=0`);
      expect(afterContext.value.liveText).toBe("");
      expect(afterContext.value.liveThinking).toBe("");
      expect((await api("GET", `/v1/sessions/${id}/context`)).value.context.messages).toEqual([finalMessage]);
    } finally {
      releaseGate("live-stream-next");
      releaseGate("live-stream");
    }
  });

  test("keeps every thinking content block visible until its message commits", async () => {
    const id = await createThread("home", "astra");
    resetGate("thinking-blocks");
    try {
      await api("POST", `/v1/sessions/${id}/prompt`, { requestId: crypto.randomUUID(), text: "thinking-blocks" });
      await waitForGate("thinking-blocks");
      const streaming = await waitFor(async () => (await api("GET", `/v1/sessions/${id}/events?after=0`)).value,
        (value) => value.liveThinking === "first thought\n\nsecond thought");
      expect(streaming.events.filter((event: any) => event.type === "thinking")).toHaveLength(0);

      releaseGate("thinking-blocks");
      const settled = await waitFor(async () => (await api("GET", `/v1/sessions/${id}/events?after=0`)).value,
        (value) => value.session.state === "IDLE");
      const finalMessage = { role: "assistant", content: [{ type: "thinking", thinking: "" }, { type: "text", text: "block answer" }] };
      const finalization = messageFinalizationKey(finalMessage);
      expect(settled.liveThinking).toBe("first thought\n\nsecond thought");
      expect(settled.events.filter((event: any) => event.type === "thinking")).toEqual([
        expect.objectContaining({ text: "first thought\n\nsecond thought", finalizesMessage: finalization }),
      ]);
    } finally {
      releaseGate("thinking-blocks");
    }
  });

  test("does not clear newer thinking when an earlier message context arrives", async () => {
    const id = await createThread("home", "astra");
    resetGate("thinking-handoff-next");
    resetGate("thinking-handoff-current");
    try {
      await api("POST", `/v1/sessions/${id}/prompt`, { requestId: crypto.randomUUID(), text: "thinking-handoff" });
      await waitForGate("thinking-handoff-next");
      releaseGate("thinking-handoff-next");
      await waitForGate("thinking-handoff-current");
      await waitFor(async () => (await api("GET", `/v1/sessions/${id}/events?after=0`)).value,
        (value) => value.liveThinking === "first message\n\nsecond message");

      const firstMessage = { role: "assistant", content: [{ type: "thinking", thinking: "first message\n\n" }, { type: "text", text: "first answer" }] };
      await api("PUT", `/v1/sessions/${id}/context`, {
        capturedAt: 440,
        context: { systemPrompt: "System", tools: [], messages: [firstMessage] },
        finalizesMessage: messageFinalizationKey(firstMessage),
      });
      const afterContext = await api("GET", `/v1/sessions/${id}/events?after=0`);
      expect(afterContext.value.liveThinking).toBe("second message");

      releaseGate("thinking-handoff-current");
      const settled = await waitFor(async () => (await api("GET", `/v1/sessions/${id}/events?after=0`)).value,
        (value) => value.session.state === "IDLE");
      expect(settled.liveThinking).toBe("second message");
    } finally {
      releaseGate("thinking-handoff-next");
      releaseGate("thinking-handoff-current");
    }
  });

  test("retains streamed thinking when context commits first and the final message omits it", async () => {
    const id = await createThread("home", "astra");
    resetGate("thinking-omitted");
    try {
      await api("POST", `/v1/sessions/${id}/prompt`, { requestId: crypto.randomUUID(), text: "thinking-omitted" });
      await waitForGate("thinking-omitted");
      const finalMessage = { role: "assistant", content: [{ type: "thinking", thinking: "" }, { type: "text", text: "done thinking" }] };
      const finalization = messageFinalizationKey(finalMessage);
      await api("PUT", `/v1/sessions/${id}/context`, {
        capturedAt: 450,
        context: { systemPrompt: "System", tools: [], messages: [finalMessage] },
        finalizesMessage: finalization,
      });

      const streaming = await waitFor(
        () => api("GET", `/v1/sessions/${id}/events?after=0`),
        (result) => result.value.liveThinking === "visible thought",
      );
      expect(streaming.value.liveThinking).toBe("visible thought");
      expect(streaming.value.session.state).toBe("RUNNING");

      releaseGate("thinking-omitted");
      const settled = await waitFor(async () => (await api("GET", `/v1/sessions/${id}/events?after=0`)).value, (value) => value.session.state === "IDLE");
      expect(settled.liveThinking).toBe("");
      const thinking = settled.events.find((event: any) => event.type === "thinking");
      expect(thinking).toMatchObject({ text: "visible thought", finalizesMessage: finalization });
      expect((await api("GET", `/v1/sessions/${id}/context`)).value.context.messages).toEqual([finalMessage]);

      const display = await api("POST", "/v1/sync", { seq: 0, waitMs: 0, session: { id } });
      const displayed = JSON.parse(display.value.session.context.document);
      expect(displayed.messages[0].content[0]).toEqual({ type: "thinking", thinking: "visible thought" });
    } finally {
      releaseGate("thinking-omitted");
    }
  });

  test("forks before a selected user message and rebuilds the durable conversation projection", async () => {
    const id = await createThread("home", "astra");
    const request = { requestId: crypto.randomUUID(), messageTimestamp: 200 };
    const forked = await api("POST", `/v1/sessions/${id}/fork`, request);
    expect(forked.status).toBe(200);
    expect(forked.value.text).toBe("edit this");
    expect(forked.value.session.state).toBe("IDLE");

    const commands = readFileSync(fakeRpcLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(commands.filter((command) => command.sessionId === id && command.type === "fork" && command.entryId === "edit-u2")).toHaveLength(1);
    const repeated = await api("POST", `/v1/sessions/${id}/fork`, request);
    expect(repeated.value.text).toBe("edit this");
    const afterRepeat = readFileSync(fakeRpcLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(afterRepeat.filter((command) => command.sessionId === id && command.type === "fork")).toHaveLength(1);
    const events = await api("GET", `/v1/sessions/${id}/events?after=0`);
    expect(events.value.events.filter((event: any) => event.type === "user").map((event: any) => event.text)).toEqual(["keep this"]);
    expect(events.value.events.filter((event: any) => event.type === "assistant").map((event: any) => event.text)).toEqual(["keep reply"]);
  });

  test("confirms an empty selected context even when the client has not loaded its cache yet", async () => {
    const id = await createThread("home", "astra");
    const result = await api("POST", "/v1/sync", { seq: 0, waitMs: 0, session: { id } });
    expect(result.value.session.context).toEqual({ kind: "clear", capturedAt: 0, hash: "" });
  });

  test("resumes uploads by committed offset and serves byte ranges", async () => {
    const id = await createThread("home", "astra");
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

  test("hard steer kills the active run and sends the chosen message next", async () => {
    const id = await createThread();
    const runtimePid = JSON.parse(readFileSync(fakeLaunch, "utf8")).pid;
    rmSync(fakeChildPid, { force: true });
    await api("POST", `/v1/sessions/${id}/prompt`, { requestId: crypto.randomUUID(), text: "group-child" });
    const childPid = await waitFor(
      async () => existsSync(fakeChildPid) ? Number(readFileSync(fakeChildPid, "utf8")) : 0,
      (pid) => pid > 1,
    );
    await api("POST", `/v1/sessions/${id}/prompt`, {
      requestId: crypto.randomUUID(), text: "soft-steer-first", delivery: "steer",
    });
    await waitFor(
      () => api("GET", `/v1/sessions/${id}`).then((result) => result.value.session),
      (session) => session.steeringQueued === 1,
    );
    await api("POST", `/v1/sessions/${id}/prompt`, {
      requestId: crypto.randomUUID(), text: "later-run", delivery: "followUp",
    });
    await api("POST", `/v1/sessions/${id}/prompt`, {
      requestId: crypto.randomUUID(), text: "hard-steer-now", delivery: "followUp",
    });
    const queued = await waitFor(
      () => api("GET", `/v1/sessions/${id}`).then((result) => result.value.session),
      (session) => session.queuedMessages?.some((message: any) => message.text === "hard-steer-now"),
    );
    const chosen = queued.queuedMessages.find((message: any) => message.text === "hard-steer-now");
    expect(chosen).toMatchObject({ delivery: "followUp", canHardSteer: true });

    const steered = await api("POST", `/v1/sessions/${id}/queue/${chosen.id}/hard-steer`, {});
    expect(steered).toMatchObject({ status: 200, value: { ok: true, hardSteer: true, workId: chosen.id } });
    await waitFor(
      async () => {
        try { process.kill(childPid, 0); return false; } catch { return true; }
      },
      Boolean,
    );
    await waitFor(
      async () => JSON.parse(readFileSync(fakeLaunch, "utf8")).pid,
      (pid) => pid !== runtimePid,
    );
    await waitFor(
      () => api("GET", `/v1/sessions/${id}/events?after=0`).then((result) => result.value),
      (value) => value.session.state === "IDLE"
        && value.events.some((event: any) => event.type === "assistant" && event.text === "hard steer ran")
        && value.events.some((event: any) => event.type === "assistant" && event.text === "later ran"),
    );
    const commands = readJsonLines(fakeRpcLog).filter((entry: any) => entry.sessionId === id);
    expect(commands.filter((entry: any) => entry.type === "abort")).toEqual([]);
    expect(commands.filter((entry: any) => entry.type === "steer").map((entry: any) => entry.message))
      .toEqual(["soft-steer-first"]);
    const prompts = commands.filter((entry: any) => entry.type === "prompt").map((entry: any) => entry.message);
    expect(prompts[0]).toBe("group-child");
    expect(prompts[1]).toContain("hard-steer-now");
    expect(prompts[2]).toBe("later-run");
    const ledger = new Database(join(root, "data", "supervisor.sqlite3"), { readonly: true });
    const work = ledger.query("SELECT text,delivery,state FROM work_items WHERE session_id=? ORDER BY created_at,rowid").all(id) as any[];
    ledger.close();
    expect(work).toEqual([
      { text: "group-child", delivery: "prompt", state: "cancelled" },
      { text: "soft-steer-first", delivery: "steer", state: "cancelled" },
      { text: "later-run", delivery: "followUp", state: "complete" },
      { text: "hard-steer-now", delivery: "hardSteer", state: "complete" },
    ]);
  }, 20_000);

  test("leaves the agent process running when Pi refuses an ordinary abort", async () => {
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
    // The agent waits at its gate, so the epoch changes before the child exits
    // however loaded the machine is.
    await waitForGate("lease-exit");
    const ledger = new Database(join(root, "data", "supervisor.sqlite3"));
    ledger.exec("PRAGMA busy_timeout=5000");
    const epoch = String((ledger.query("SELECT value FROM metadata WHERE key='supervisor_epoch'").get() as any).value);
    try {
      ledger.query("UPDATE metadata SET value='replacement-test' WHERE key='supervisor_epoch'").run();
      releaseGate("lease-exit");
      await waitFor(
        async () => { try { process.kill(JSON.parse(readFileSync(fakeLaunch, "utf8")).pid, 0); return false; } catch { return true; } },
        Boolean,
      );
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

  test("a busy coordinator receives child results by steer before its turn ends", async () => {
    const parent = await createThread("home", "astra");
    await api("POST", `/v1/sessions/${parent}/prompt`, { requestId: crypto.randomUUID(), text: "holding coordinator" });
    const child = await api("POST", "/v1/sessions", { requestId: crypto.randomUUID(), parentSessionId: parent, model: "luna", task: "delegate busy result" });
    expect(child.status).toBe(201);
    const received = await waitFor(() => api("GET", `/v1/sessions/${parent}/events`).then((r) => r.value),
      (value) => value.events.some((event: any) => event.type === "assistant" && event.text === "received steered result"));
    expect(received.session.state).toBe("RUNNING");
    const deliveries = readJsonLines(fakeRpcLog).filter((entry) => entry.sessionId === parent && ["prompt", "steer", "follow_up"].includes(entry.type));
    expect(deliveries.filter((entry) => entry.type === "steer" && entry.message.includes('"type":"thread_result"'))).toHaveLength(1);
    expect(deliveries.filter((entry) => entry.type === "follow_up")).toHaveLength(0);
    await api("POST", `/v1/sessions/${parent}/abort`, { requestId: crypto.randomUUID() });
  });

  test("an interrupted coordinator receives accepted delegation receipts before continuing", async () => {
    const parent = await createThread("home", "astra");
    await api("POST", `/v1/sessions/${parent}/prompt`, { requestId: crypto.randomUUID(), text: "holding coordinator" });
    const accepted = await api("POST", "/v1/sessions", { requestId: crypto.randomUUID(), parentSessionId: parent, model: "luna", task: "delegate accepted before disconnect" });
    expect(accepted.status).toBe(201);
    const child = accepted.value.session.id;
    await waitFor(() => api("GET", `/v1/sessions/${child}`).then((r) => r.value.session), (session) => session.state === "IDLE");
    server.kill("SIGTERM");
    await server.exited;
    await startServer();
    const prompts = await waitFor(async () => readJsonLines(fakeRpcLog).filter((entry) => entry.sessionId === parent && entry.type === "prompt"),
      (entries) => entries.some((entry) => entry.message.includes('"type":"accepted_delegations"')));
    const recovery = prompts.find((entry) => entry.message.includes('"type":"accepted_delegations"'));
    expect(recovery.message).toContain(child);
    expect(recovery.message).toContain(accepted.value.delegation.workId);
  });

  test("a completed subagent delivers its saved result once after the coordinator supervisor restarts", async () => {
    const parent = await createThread("home", "astra");
    server.kill("SIGTERM");
    await server.exited;
    const child = crypto.randomUUID();
    const work = crypto.randomUUID();
    const ledger = new Database(join(root, "data", "supervisor.sqlite3"));
    ledger.exec("PRAGMA foreign_keys=ON");
    ledger.transaction(() => {
      ledger.query(`INSERT INTO sessions(id,name,workspace_id,state,created_at,updated_at,profile_id,initial_provider,initial_model)
        VALUES(?,'saved child','home','IDLE','t','t','home','openai-codex','gpt-5.6-luna')`).run(child);
      ledger.query("INSERT INTO subagents VALUES(?,?,'openai-codex','gpt-5.6-luna')").run(child, parent);
      const event = ledger.query("INSERT INTO events(session_id,time,type,payload) VALUES(?,'t','user','{}')").run(child);
      ledger.query(`INSERT INTO work_items(id,session_id,request_id,event_seq,text,state,available_at,created_at,updated_at)
        VALUES(?,?,?,?,'delegate persisted task','dispatched',0,'t','t')`).run(work, child, crypto.randomUUID(), event.lastInsertRowid);
      ledger.query("INSERT INTO thread_delegations VALUES(?,?,NULL)").run(work, parent);
      ledger.query("INSERT INTO events(session_id,time,type,payload) VALUES(?,'t','assistant',?)")
        .run(child, JSON.stringify({ text: "saved result before supervisor loss" }));
      ledger.query("UPDATE work_items SET state='complete' WHERE id=?").run(work);
    })();
    ledger.close();
    await startServer();
    await waitFor(() => api("GET", `/v1/sessions/${parent}/events`).then((r) => r.value),
      (value) => value.events.some((event: any) => event.type === "user" && event.text.includes("saved result before supervisor loss")));
    server.kill("SIGTERM");
    await server.exited;
    await startServer();
    const events = (await api("GET", `/v1/sessions/${parent}/events`)).value.events;
    expect(events.filter((event: any) => event.type === "user" && event.text.includes("saved result before supervisor loss"))).toHaveLength(1);
    const persisted = new Database(join(root, "data", "supervisor.sqlite3"), { readonly: true });
    try {
      expect(persisted.query("SELECT count(*) AS n FROM work_items WHERE request_id=?").get(`thread-result-${work}`)).toEqual({ n: 1 });
      expect((await api("GET", `/v1/sessions/${child}`)).value.session.subagent).toEqual({ parentSessionId: parent, model: "gpt-5.6-luna" });
    } finally { persisted.close(); }
  });

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
