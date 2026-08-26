import { Database } from "bun:sqlite";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { parseRunKey } from "./agent-runs";
import { AgentHost, LocalLedger, RemoteLedger, sshRunner } from "./agent-hosts";
import { loadPlanUsage, type PlanUsageSnapshot } from "./plan-usage";
import { loadProviderManifest, manifestAgentType, manifestPlanCards } from "./provider-manifest";
import { readMachineUsage } from "./machine-usage";
import { displayContextDocument } from "./context-display";
import { applyContextSplice, contextSplice, sha256, type ContextSplice } from "./sync";
import { beginSupervisorGeneration, ensureSupervisorSchema } from "./database";
import { BOOSTED_MULTIPLIER, nextBoost } from "pi-orchestrator/boost";
import { DEFAULT_LIVE_MODEL, DEFAULT_LIVE_VOICE, VoiceBroker } from "pi-orchestrator/voice";
type VoiceAccount = { id: string; provider: string; accessUntil?: number; cooldownUntil?: number };

const VERSION = "0.44.0";
const ENVIRONMENT_ID = process.env.PI_REMOTE_ENVIRONMENT_ID ?? "local";
const ENVIRONMENT_NAME = process.env.PI_REMOTE_ENVIRONMENT_NAME ?? "Local";
const ENVIRONMENT_REQUIRES_UNLOCK = process.env.PI_REMOTE_REQUIRES_UNLOCK === "true";
if (!/^[a-z][a-z0-9-]{0,31}$/.test(ENVIRONMENT_ID)) throw new Error("PI_REMOTE_ENVIRONMENT_ID must be a stable lowercase identifier");
const PROVIDER_MANIFEST = loadProviderManifest();
const SUPERVISOR_EPOCH = crypto.randomUUID();
const HOME = homedir();
const DATA = process.env.PI_REMOTE_DATA ?? join(process.env.XDG_STATE_HOME ?? join(HOME, ".local/state"), "pi-remote");
const INGESTION = process.env.PI_REMOTE_INGESTION ?? join(DATA, "ingestion");
const PI = process.env.PI_BIN ?? "pi";
const AUDIO = process.env.PI_REMOTE_AUDIO_BIN ?? "audio";
const NICE = process.env.PI_REMOTE_NICE ?? "nice";
type RemoteTarget = { id: string; name: string; ssh: string; home: string; cwd: string };
const remoteTargets = JSON.parse(process.env.PI_REMOTE_TARGETS ?? "[]") as RemoteTarget[];
const REMOTE_TARGETS = new Map<string, RemoteTarget>(remoteTargets.map((target) => [target.id, target]));
const PRIVATE_ID = process.env.PI_REMOTE_PRIVATE_ID ?? "private";
const PRIVATE_NAME = process.env.PI_REMOTE_PRIVATE_NAME ?? "Private";
const PRIVATE_DIR = process.env.PI_REMOTE_PRIVATE_DIR ?? join(HOME, PRIVATE_ID);
const WORK_SHADOW = process.env.PI_REMOTE_WORK_SHADOW ?? join(DATA, "work-shadow");
const WORK_EXTENSION = join(import.meta.dir, "work-remote.ts");
const SERVICE_TIER_EXTENSION = join(import.meta.dir, "service-tier.ts");
const THREAD_CONTEXT_EXTENSION = join(import.meta.dir, "thread-context.ts");
const SERVICE_TIER_DIR = join(DATA, "service-tiers");
const ORCHESTRATOR_DB_PATH = process.env.PI_REMOTE_ORCHESTRATOR_DB ?? join(HOME, ".local/share/pi-orchestrator/ledger.sqlite3");
const ORCHESTRATOR_AUTH_PATH = process.env.PI_ORCHESTRATOR_AUTH ?? join(dirname(realpathSync(ORCHESTRATOR_DB_PATH)), "auth.json");
const ORCHESTRATOR_RUNS_ROOT = process.env.PI_REMOTE_ORCHESTRATOR_RUNS ?? join(HOME, ".local/share/pi-orchestrator/runs");
const WORK_ORCHESTRATOR_DB_PATH = process.env.PI_REMOTE_WORK_ORCHESTRATOR_DB;
const WORK_ORCHESTRATOR_RUNS_ROOT = process.env.PI_REMOTE_WORK_ORCHESTRATOR_RUNS;
const WORK_ORCHESTRATOR_REMOTE_DB_PATH = process.env.PI_REMOTE_WORK_ORCHESTRATOR_REMOTE_DB;
const WORK_ORCHESTRATOR_REMOTE_RUNS_ROOT = process.env.PI_REMOTE_WORK_ORCHESTRATOR_REMOTE_RUNS;
const WORK_AGENT_SSH = process.env.PI_REMOTE_WORK_AGENT_SSH;
const WORK_AGENT_REFRESH_MS = Math.max(5_000, Number(process.env.PI_REMOTE_WORK_AGENT_REFRESH_MS ?? "15000"));
const WORK_AGENT_MAX_AGE_MS = Math.max(1_000, Number(process.env.PI_REMOTE_WORK_AGENT_MAX_AGE_MS ?? "4000"));
const LOCAL_AGENT_MAX_AGE_MS = Math.max(0, Number(process.env.PI_REMOTE_LOCAL_AGENT_MAX_AGE_MS ?? "500"));
const HOST = process.env.PI_REMOTE_HOST ?? "127.0.0.1";
const PORT = Number(process.env.PI_REMOTE_PORT ?? "8788");
const AGENT_DIR = process.env.PI_AGENT_DIR ?? join(HOME, ".pi/agent");
const WEB_DIR = join(import.meta.dir, "../web");
const PACKAGE_ROOT = realpathSync(join(import.meta.dir, ".."));

function configuredPackageSource(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (!entry || typeof entry !== "object" || !("source" in entry)) return null;
  return typeof entry.source === "string" ? entry.source : null;
}

function assertContextMirrorLoadsLast() {
  const settingsPath = join(AGENT_DIR, "settings.json");
  let settings: { packages?: unknown[] };
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch (error) {
    throw new Error(`Pi Remote requires its context capture package to be installed last. Could not read ${settingsPath}: ${error instanceof Error ? error.message : error}`);
  }
  const source = configuredPackageSource(settings.packages?.at(-1));
  let configuredRoot: string | null = null;
  if (source && !source.startsWith("npm:") && !source.startsWith("git:") && !source.includes("://")) {
    try {
      configuredRoot = realpathSync(isAbsolute(source) ? source : resolve(AGENT_DIR, source));
    } catch {
      configuredRoot = null;
    }
  }
  if (configuredRoot !== PACKAGE_ROOT) {
    throw new Error(`Pi Remote's package must be the final entry in ${settingsPath} so context-mirror.ts observes every context transformation. Run: pi remove ${PACKAGE_ROOT}; pi install ${PACKAGE_ROOT}`);
  }
}

assertContextMirrorLoadsLast();

// Starting a thread is two independent choices: where it runs, and which model runs there.
// Both clients read this manifest rather than carrying their own copy of the combinations.
// Luna is still an orchestrator agent; it is only the hand-started thread that does not offer
// it, because two GPT choices in a wordless menu are one choice too many to tell apart.
//
// Two rules make a wordless menu navigable, and both live here rather than in a client.
//
// Order is rarest first, because the choices are laid out rightward toward the button that
// became them: the last one lands exactly under the finger that opened the menu, so the
// everyday pick costs no travel and the whole path — Home, then Opus — is two taps in one
// spot. Each destination orders its own models by how often it is that destination's answer.
//
// Colour says what kind of thing a dot is, and the glyph says which one. Destinations wear
// cool place colours and a pictogram; models wear their provider's colour and their own
// initial, so the two Claude models read as a pair without either being mistaken for the
// other. Green is the default place and the loudest, blue the cloud and the quietest.
const THREAD_MODELS = new Map([
  ["sol", { id: "sol", label: "SOL", icon: "sol", accent: "#5a6673", provider: "openai-codex", modelId: "gpt-5.6-sol" }],
  ["opus", { id: "opus", label: "OPUS", icon: "opus", accent: "#d9663d", provider: "anthropic", modelId: "claude-opus-5" }],
  ["fable", { id: "fable", label: "FABLE", icon: "fable", accent: "#e6a23c", provider: "anthropic", modelId: "claude-fable-5" }],
]);
// A destination that offers no model choice is started straight from its default, which is
// why the work machine has no second step: Anthropic models do not run there.
const OFFERED_DESTINATIONS = (process.env.PI_REMOTE_DESTINATIONS ?? "home").split(",").map((id) => id.trim()).filter(Boolean);
const destinationDefinitions = JSON.parse(process.env.PI_REMOTE_THREAD_DESTINATIONS ?? JSON.stringify([
  { id: "home", label: "HOME", icon: "house", accent: "#3fb950", workspaceId: "home", executionTarget: "local", thinkingLevel: "high", models: ["sol", "fable", "opus"], defaultModel: "opus" },
])) as Array<{ id: string; label: string; icon: string; accent: string; workspaceId: string; executionTarget: string; thinkingLevel: string; models: string[]; defaultModel: string }>;
const THREAD_DESTINATIONS = new Map(destinationDefinitions
  .filter((destination) => OFFERED_DESTINATIONS.includes(destination.id))
  .map((destination) => [destination.id, destination]));

function threadStartProfiles() {
  return [...THREAD_DESTINATIONS.values()].map((destination) => ({
    id: destination.id,
    label: destination.label,
    icon: destination.icon,
    accent: destination.accent,
    defaultModel: destination.defaultModel,
    models: destination.models.map((id) => {
      const model = THREAD_MODELS.get(id);
      if (!model) throw new Error(`Unknown thread model ${id} in profile ${destination.id}`);
      return { id: model.id, label: model.label, icon: model.icon, accent: model.accent };
    }),
  }));
}

function environmentMetadata() {
  return {
    id: ENVIRONMENT_ID,
    name: ENVIRONMENT_NAME,
    requiresUnlock: ENVIRONMENT_REQUIRES_UNLOCK,
    profiles: threadStartProfiles(),
    capabilities: { voice: true, downloads: true, notifications: true },
  };
}

const PLAN_USAGE_REFRESH_MS = Math.max(15_000, Number(process.env.PI_REMOTE_PLAN_USAGE_REFRESH_MS ?? "60000"));
const PROMPT_ACK_TIMEOUT_MS = Math.max(100, Number(process.env.PI_REMOTE_PROMPT_ACK_TIMEOUT_MS ?? "30000"));
const STATE_RECONCILE_MS = Math.max(50, Number(process.env.PI_REMOTE_STATE_RECONCILE_MS ?? "15000"));
const workspaceDefinitions = JSON.parse(process.env.PI_REMOTE_WORKSPACES ?? JSON.stringify([
  { id: "home", name: "Home", path: HOME },
  { id: PRIVATE_ID, name: PRIVATE_NAME, path: PRIVATE_DIR },
])) as Array<{ id: string; name: string; path: string }>;
const workspaces = new Map(workspaceDefinitions
  .filter((workspace) => existsSync(workspace.path))
  .map((workspace) => [workspace.id, workspace]));
for (const workspace of workspaces.values()) workspace.path = realpathSync(workspace.path);

mkdirSync(DATA, { recursive: true, mode: 0o700 });
mkdirSync(join(DATA, "sessions"), { recursive: true, mode: 0o700 });
mkdirSync(SERVICE_TIER_DIR, { recursive: true, mode: 0o700 });
mkdirSync(INGESTION, { recursive: true, mode: 0o700 });
mkdirSync(WORK_SHADOW, { recursive: true, mode: 0o700 });
const db = new Database(join(DATA, "supervisor.sqlite3"), { create: true, strict: true });
const orchestratorDb = new Database(ORCHESTRATOR_DB_PATH, { readonly: true, strict: true });
orchestratorDb.exec("PRAGMA busy_timeout=5000;");
// The GPT-Live pool is the orchestrator's account ledger and shared Codex
// credential store, the same custody used by interactive and fleet sessions.
const voiceAccounts = new VoiceBroker({
  authPath: ORCHESTRATOR_AUTH_PATH,
  agentDir: AGENT_DIR,
  accounts: (): VoiceAccount[] => (orchestratorDb
    .query("SELECT id, provider, access_until accessUntil, cooldown_until cooldownUntil FROM account WHERE provider='openai-codex'")
    .all() as any[])
    .map((row) => ({
      id: row.id,
      provider: row.provider,
      accessUntil: row.accessUntil ?? undefined,
      cooldownUntil: row.cooldownUntil ?? undefined,
    })),
});
// Autonomous agents run on more than one machine. Each host owns an identical
// pi-orchestrator ledger and runs directory, so the drawer's agent list is the
// union of the hosts rather than a view of this machine alone.
const agentHosts = [
  new AgentHost(new LocalLedger(orchestratorDb, ORCHESTRATOR_RUNS_ROOT), {
    key: "local", label: "THIS MACHINE", name: "This machine",
    manifest: PROVIDER_MANIFEST, maxAgeMs: LOCAL_AGENT_MAX_AGE_MS,
  }),
];
if (WORK_ORCHESTRATOR_DB_PATH) {
  agentHosts.push(new AgentHost(
    new LocalLedger(WORK_ORCHESTRATOR_DB_PATH, WORK_ORCHESTRATOR_RUNS_ROOT ?? join(dirname(WORK_ORCHESTRATOR_DB_PATH), "runs")),
    { key: "work", label: process.env.PI_REMOTE_WORK_AGENT_LABEL ?? "WORK", name: process.env.PI_REMOTE_WORK_AGENT_NAME ?? "Work host", manifest: PROVIDER_MANIFEST, maxAgeMs: WORK_AGENT_MAX_AGE_MS },
  ));
} else if (WORK_AGENT_SSH && WORK_ORCHESTRATOR_REMOTE_DB_PATH && WORK_ORCHESTRATOR_REMOTE_RUNS_ROOT) {
  agentHosts.push(new AgentHost(
    new RemoteLedger(WORK_ORCHESTRATOR_REMOTE_DB_PATH, WORK_ORCHESTRATOR_REMOTE_RUNS_ROOT, sshRunner(WORK_AGENT_SSH)),
    { key: "work", label: process.env.PI_REMOTE_WORK_AGENT_LABEL ?? "WORK", name: process.env.PI_REMOTE_WORK_AGENT_NAME ?? "Work host", manifest: PROVIDER_MANIFEST, maxAgeMs: WORK_AGENT_MAX_AGE_MS },
  ));
}
const agentHostsByKey = new Map(agentHosts.map((host) => [host.key, host]));
ensureSupervisorSchema(db);
beginSupervisorGeneration(db, SUPERVISOR_EPOCH);

type RuntimePhase = "STARTING" | "IDLE" | "DISPATCHING" | "RUNNING" | "ABORTING" | "STOPPING";

interface Runtime {
  proc: ReturnType<typeof Bun.spawn>;
  pending: Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: Timer }>;
  phase: RuntimePhase;
  phaseVersion: number;
  compacting: boolean;
  retrying: boolean;
  reconciling: boolean;
  suppressOutput: boolean;
  liveText: string;
  liveThinking: string;
  pendingModelFailure: string | null;
  expectedExit: boolean;
  lastActivity: number;
  activeTools: Map<string, string>;
  dispatchedWorkIds: Set<string>;
  steeringQueued: number;
  followUpQueued: number;
  historyNeedsRestore: boolean;
  modelId: string;
}
const runtimes = new Map<string, Runtime>();
const activations = new Map<string, Promise<Runtime>>();
const sessionWorkers = new Map<string, Promise<void>>();
const retryTimers = new Map<string, Timer>();
let shuttingDown = false;

const now = () => new Date().toISOString();
const serviceTierPath = (sessionId: string) => join(SERVICE_TIER_DIR, sessionId);
function writeServiceTier(sessionId: string, tier: "default" | "priority") {
  writeFileSync(serviceTierPath(sessionId), tier + "\n", { mode: 0o600 });
}
type ProviderPlanUsageState = PlanUsageSnapshot["openai"] & { state: PlanUsageSnapshot["openai"]["state"] | "loading" };
type AnthropicPlanUsageState = PlanUsageSnapshot["anthropic"] & { state: PlanUsageSnapshot["anthropic"]["state"] | "loading" };
type CursorPlanUsageState = PlanUsageSnapshot["cursor"] & { state: PlanUsageSnapshot["cursor"]["state"] | "loading" };
type PlanUsageState = {
  openai: ProviderPlanUsageState;
  anthropic: AnthropicPlanUsageState;
  cursor: CursorPlanUsageState;
  updatedAt: string;
};
const loadingProviderPlanUsage = (): ProviderPlanUsageState => ({
  state: "loading", percentLeft: null, expectedPercentLeft: null, paceDelta: null, planCount: 0, checkedCount: 0,
});
const loadingAnthropicPlanUsage = (): AnthropicPlanUsageState => ({
  ...loadingProviderPlanUsage(),
  fablePercentLeft: null, fableExpectedPercentLeft: null, fablePaceDelta: null,
  weeklyPercentLeft: null, weeklyExpectedPercentLeft: null, weeklyPaceDelta: null,
});
const loadingCursorPlanUsage = (): CursorPlanUsageState => ({
  ...loadingProviderPlanUsage(), percentUsed: null,
});
let planUsage: PlanUsageState = {
  openai: loadingProviderPlanUsage(),
  anthropic: loadingAnthropicPlanUsage(),
  cursor: loadingCursorPlanUsage(),
  updatedAt: now(),
};
let planUsageRefresh: Promise<void> | null = null;
let nextPlanUsageRefresh = 0;

function refreshPlanUsageIfDue() {
  if (planUsageRefresh || Date.now() < nextPlanUsageRefresh) return;
  nextPlanUsageRefresh = Date.now() + PLAN_USAGE_REFRESH_MS;
  planUsageRefresh = loadPlanUsage({
    agentDir: AGENT_DIR,
    openaiAuthPath: ORCHESTRATOR_AUTH_PATH,
    ledgerPath: ORCHESTRATOR_DB_PATH,
  })
    .then((snapshot) => { planUsage = snapshot; })
    .catch((cause) => {
      console.error("Plan usage refresh failed", cause);
      planUsage = {
        openai: planUsage.openai.percentLeft === null ? { ...planUsage.openai, state: "unavailable" } : planUsage.openai,
        anthropic: planUsage.anthropic.percentLeft === null ? { ...planUsage.anthropic, state: "unavailable" } : planUsage.anthropic,
        cursor: planUsage.cursor.percentUsed === null ? { ...planUsage.cursor, state: "unavailable" } : planUsage.cursor,
        updatedAt: now(),
      };
    })
    .finally(() => { planUsageRefresh = null; });
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
});

function compressedJson(req: Request, data: unknown, status = 200): Response {
  const encoded = JSON.stringify(data);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "cache-control": "no-store",
    vary: "accept-encoding",
  };
  if (encoded.length >= 1_024 && /(?:^|,)\s*gzip(?:\s*;|\s*,|$)/i.test(req.headers.get("accept-encoding") ?? "")) {
    headers["content-encoding"] = "gzip";
    return new Response(Bun.gzipSync(Buffer.from(encoded)), { status, headers });
  }
  return new Response(encoded, { status, headers });
}

let syncSequence = 1;
const syncWaiters = new Set<() => void>();
function signalSync() {
  syncSequence++;
  for (const wake of syncWaiters) wake();
  syncWaiters.clear();
}
async function awaitSync(after: number, waitMs: number) {
  if (after !== syncSequence) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      syncWaiters.delete(finish);
      resolve();
    };
    const timer = setTimeout(finish, Math.min(30_000, Math.max(0, waitMs)));
    syncWaiters.add(finish);
  });
}

const contextVersions = new Map<string, Map<string, string>>();
const displayContexts = new Map<string, { sourceHash: string; document: string; hash: string }>();
function rememberContext(sessionId: string, document: string): string {
  const hash = sha256(document);
  let versions = contextVersions.get(sessionId);
  if (!versions) {
    versions = new Map();
    contextVersions.set(sessionId, versions);
  }
  versions.delete(hash);
  versions.set(hash, document);
  while (versions.size > 12) versions.delete(versions.keys().next().value!);
  return hash;
}

function displayContext(sessionId: string, sourceHash: string, sourceDocument: string) {
  const cached = displayContexts.get(sessionId);
  if (cached?.sourceHash === sourceHash) {
    displayContexts.delete(sessionId);
    displayContexts.set(sessionId, cached);
    return cached;
  }
  const document = displayContextDocument(sourceDocument);
  const projected = { sourceHash, document, hash: rememberContext(sessionId, document) };
  displayContexts.delete(sessionId);
  displayContexts.set(sessionId, projected);
  while (displayContexts.size > 4) displayContexts.delete(displayContexts.keys().next().value!);
  return projected;
}

function textUpdate(key: string, baseHash: unknown, target: string): any {
  const targetHash = rememberContext(key, target);
  if (baseHash === targetHash) return null;
  const base = typeof baseHash === "string" ? contextVersions.get(key)?.get(baseHash) : undefined;
  return base === undefined
    ? { kind: "full", capturedAt: Date.now(), hash: targetHash, document: target }
    : { kind: "splice", capturedAt: Date.now(), hash: targetHash, splice: contextSplice(base, target) };
}

function storedContext(sessionId: string): { capturedAt: number; document: string; hash: string } | null {
  const base = db.query("SELECT captured_at,context FROM session_contexts WHERE session_id=?").get(sessionId) as any;
  if (!base) return null;
  let document = String(base.context);
  let capturedAt = Number(base.captured_at);
  for (const row of db.query("SELECT * FROM session_context_patches WHERE session_id=? ORDER BY seq").all(sessionId) as any[]) {
    document = applyContextSplice(document, {
      baseHash: String(row.base_hash),
      targetHash: String(row.target_hash),
      prefixBytes: Number(row.prefix_bytes),
      deleteBytes: Number(row.delete_bytes),
      insertBase64: String(row.insert_base64),
    });
    capturedAt = Number(row.captured_at);
    rememberContext(sessionId, document);
  }
  return { capturedAt, document, hash: rememberContext(sessionId, document) };
}

const error = (message: string, status = 400) => json({ error: message }, status);

type ThunderStatus = { active: boolean; status: string };
type GovernorProvider = "openai" | "anthropic";
/** The drawer button's four states, in cycle order: normal pace, 3× (green),
 * 10× (blue), and halted (red — the orchestrator refuses every new launch
 * for the family while running sessions finish naturally). */
type GovernorState = "off" | "green" | "blue" | "red";
type GovernorControls = Record<
  GovernorProvider,
  { state: GovernorState; boosted: boolean; multiplier: number; boostedMultiplier: number }
>;
let thunderToggleOperation: Promise<ThunderStatus> | null = null;

// The drawer's allowance controls are a direct view of the orchestrator's own
// boost rows: one durable multiplier per provider family on the paced spend its
// broker admits against. The supervisor holds no governor state of its own —
// it reads and writes the orchestrator's ledger, and takes what "boosted" means
// from the orchestrator package, so the CLI, the controller, and both clients
// always agree on both the state and the number.
const GOVERNOR_FAMILIES: Record<GovernorProvider, string> = {
  openai: "openai-codex",
  anthropic: "anthropic",
};
let orchestratorWriteDb: Database | null = null;

function boostMultiplier(family: string): number {
  const row = orchestratorDb.query("SELECT value FROM control WHERE key=?").get(`boost:${family}`) as { value: string } | null;
  const multiplier = Number(row?.value);
  return Number.isFinite(multiplier) && multiplier >= 0 ? multiplier : 1;
}

function governorState(multiplier: number): GovernorState {
  if (multiplier === 0) return "red";
  if (multiplier === 1) return "off";
  return multiplier >= BOOSTED_MULTIPLIER ? "blue" : "green";
}

function governorControls(): GovernorControls | null {
  try {
    const controls = {} as GovernorControls;
    for (const [provider, family] of Object.entries(GOVERNOR_FAMILIES) as [GovernorProvider, string][]) {
      const multiplier = boostMultiplier(family);
      controls[provider] = {
        state: governorState(multiplier),
        boosted: multiplier > 1,
        multiplier,
        boostedMultiplier: BOOSTED_MULTIPLIER,
      };
    }
    return controls;
  } catch {
    // An orchestrator ledger without boost custody is not an error here:
    // clients hide the controls when governors is null.
    return null;
  }
}

function toggleGovernor(provider: GovernorProvider): GovernorControls {
  const family = GOVERNOR_FAMILIES[provider];
  if (!orchestratorWriteDb) orchestratorWriteDb = new Database(ORCHESTRATOR_DB_PATH, { strict: true });
  orchestratorWriteDb.exec("PRAGMA busy_timeout=5000;");
  orchestratorWriteDb
    .query("INSERT INTO control(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(`boost:${family}`, String(nextBoost(boostMultiplier(family))));
  const controls = governorControls();
  if (!controls) throw new Error("Governor controls are unavailable");
  return controls;
}

async function audioCommand(action: "status" | "thunder" | "stop"): Promise<any> {
  const proc = Bun.spawn([AUDIO, action], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr.trim() || `Audio command failed (${exitCode})`);
  try { return JSON.parse(stdout); }
  catch { throw new Error("Audio command returned invalid state"); }
}

async function thunderStatus(): Promise<ThunderStatus> {
  const status = await audioCommand("status");
  return {
    active: status.kind === "thunder" && status.status !== "stopped",
    status: String(status.status ?? "stopped"),
  };
}

function toggleThunder(): Promise<ThunderStatus> {
  if (thunderToggleOperation) return thunderToggleOperation;
  thunderToggleOperation = (async () => {
    const current = await thunderStatus();
    if (current.active) {
      await audioCommand("stop");
      return { active: false, status: "stopped" };
    }
    await audioCommand("thunder");
    return { active: true, status: "playing" };
  })().finally(() => { thunderToggleOperation = null; });
  return thunderToggleOperation;
}
const webAssets = new Map<string, readonly [string, string]>([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/voice.js", ["voice.js", "text/javascript; charset=utf-8"]],
  ["/voice-page.js", ["voice-page.js", "text/javascript; charset=utf-8"]],
  ["/voice.html", ["voice.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/manifest.webmanifest", ["manifest.webmanifest", "application/manifest+json"]],
  ["/icon.svg", ["icon.svg", "image/svg+xml"]],
  ["/openai.svg", ["openai.svg", "image/svg+xml"]],
  ["/anthropic.svg", ["anthropic.svg", "image/svg+xml"]],
  ["/work.svg", ["work.svg", "image/svg+xml"]],
  ["/personal.svg", ["personal.svg", "image/svg+xml"]],
  ["/converge.svg", ["converge.svg", "image/svg+xml"]],
  ["/thunder.svg", ["thunder.svg", "image/svg+xml"]],
]);
for (const icon of [
  ...PROVIDER_MANIFEST.plans.map((plan) => plan.icon),
  ...[...THREAD_MODELS.values()].map((model) => model.icon),
  ...[...THREAD_DESTINATIONS.values()].map((destination) => destination.icon),
]) {
  if (/^[a-z0-9_-]+$/.test(icon)) webAssets.set(`/${icon}.svg`, [`${icon}.svg`, "image/svg+xml"]);
}
const vendorContentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function downloadHeaders(path: string, size: number, contentType: string, etagValue = `${size}`): Headers {
  const name = basename(path) || "download";
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, "_") || "download";
  const encoded = encodeURIComponent(name).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return new Headers({
    "content-type": contentType || "application/octet-stream",
    "content-length": String(size),
    "content-disposition": `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`,
    "cache-control": "private, no-cache",
    "accept-ranges": "bytes",
    etag: `\"${sha256(`${path}:${etagValue}`)}\"`,
    "x-content-type-options": "nosniff",
  });
}

const REMOTE_FILE_METADATA = String.raw`
import json, mimetypes, os, pathlib, sys
requested = pathlib.Path(sys.argv[1])
if not requested.is_absolute():
    print(json.dumps({"status": 400, "error": "Valid absolute file path required"}))
    raise SystemExit
try:
    path = requested.resolve(strict=True)
    if not path.is_file() or not os.access(path, os.R_OK):
        raise FileNotFoundError
    stat = path.stat()
    print(json.dumps({
        "path": str(path),
        "size": stat.st_size,
        "contentType": mimetypes.guess_type(path.name)[0] or "application/octet-stream",
        "mtimeNs": stat.st_mtime_ns,
    }))
except (FileNotFoundError, PermissionError, OSError):
    print(json.dumps({"status": 404, "error": "File not found"}))
`;

async function remoteFileMetadata(path: string, target: RemoteTarget): Promise<any> {
  const command = `python3 -c ${shellQuote(REMOTE_FILE_METADATA)} ${shellQuote(path)}`;
  const proc = Bun.spawn(["ssh", target.ssh, command], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  if (code !== 0) throw new Error(stderr.trim() || `Could not inspect remote file (${code})`);
  try { return JSON.parse(stdout.trim()); }
  catch { throw new Error("Remote file inspection returned invalid metadata"); }
}

function childResponseBody(proc: any): ReadableStream<Uint8Array> {
  const reader = proc.stdout.getReader();
  return new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (cause) { controller.error(cause); }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); } catch {}
      try { proc.kill(); } catch {}
    },
  });
}

function byteRange(value: string | null, size: number): { start: number; end: number } | null {
  if (!value) return null;
  const match = value.match(/^bytes=(\d+)-(\d*)$/);
  if (!match) return null;
  const start = Number(match[1]);
  const end = match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start <= end && start < size
    ? { start, end }
    : null;
}

async function sessionFileResponse(url: URL, method: string, req: Request): Promise<Response | null> {
  const match = url.pathname.match(/^\/v1\/sessions\/([0-9a-f-]+)\/files$/i);
  if (!match || (method !== "GET" && method !== "HEAD")) return null;
  const row = sessionRow.get(match[1]) as any;
  if (!row) return new Response("Session not found", { status: 404 });
  const requested = url.searchParams.get("path") ?? "";
  if (!isAbsolute(requested)) return new Response("Valid absolute file path required", { status: 400 });
  const target = REMOTE_TARGETS.get(String(row.execution_target)) ?? null;
  if (target) {
    let metadata;
    try { metadata = await remoteFileMetadata(requested, target); }
    catch (cause: any) { return new Response(cause?.message ?? "Could not inspect remote file", { status: 502 }); }
    if (metadata.status) return new Response(String(metadata.error ?? "File not found"), { status: Number(metadata.status) });
    const size = Number(metadata.size);
    const headers = downloadHeaders(String(metadata.path), size, String(metadata.contentType), `${size}:${metadata.mtimeNs}`);
    const range = method === "GET" ? byteRange(req.headers.get("range"), size) : null;
    if (req.headers.has("range") && method === "GET" && !range)
      return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    if (method === "HEAD") return new Response(null, { headers });
    const start = range?.start ?? 0;
    const length = range ? range.end - range.start + 1 : size;
    if (range) {
      headers.set("content-range", `bytes ${range.start}-${range.end}/${size}`);
      headers.set("content-length", String(length));
    }
    const remoteRange = String.raw`import pathlib,sys
p=pathlib.Path(sys.argv[1]); start=int(sys.argv[2]); left=int(sys.argv[3])
with p.open('rb') as f:
 f.seek(start)
 while left:
  chunk=f.read(min(left,65536))
  if not chunk: break
  sys.stdout.buffer.write(chunk); left-=len(chunk)`;
    const command = `python3 -c ${shellQuote(remoteRange)} ${shellQuote(String(metadata.path))} ${start} ${length}`;
    const proc = Bun.spawn(["ssh", target.ssh, command], { stdout: "pipe", stderr: "pipe" });
    void new Response(proc.stderr).text().then(async (stderr) => {
      const code = await proc.exited;
      if (code !== 0) console.error(`Remote file download failed (${code}): ${stderr.trim()}`);
    }).catch((cause) => console.error("Remote file download failed", cause));
    return new Response(childResponseBody(proc), { status: range ? 206 : 200, headers });
  }
  try {
    const path = realpathSync(requested);
    const stat = statSync(path);
    if (!stat.isFile()) return new Response("File not found", { status: 404 });
    const file = Bun.file(path);
    const headers = downloadHeaders(path, stat.size, file.type, `${stat.size}:${stat.mtimeMs}`);
    const range = method === "GET" ? byteRange(req.headers.get("range"), stat.size) : null;
    if (req.headers.has("range") && method === "GET" && !range)
      return new Response(null, { status: 416, headers: { "content-range": `bytes */${stat.size}` } });
    if (!range) return new Response(method === "HEAD" ? null : file, { headers });
    headers.set("content-range", `bytes ${range.start}-${range.end}/${stat.size}`);
    headers.set("content-length", String(range.end - range.start + 1));
    return new Response(file.slice(range.start, range.end + 1), { status: 206, headers });
  } catch { return new Response("File not found", { status: 404 }); }
}

function webResponse(pathname: string, method: string): Response | null {
  if (method !== "GET" && method !== "HEAD") return null;
  let asset = webAssets.get(pathname);
  if (!asset && pathname.startsWith("/vendor/")) {
    const relative = pathname.slice(1);
    if (relative.split("/").some((part) => !part || part === "." || part === "..")) return null;
    const file = join(WEB_DIR, relative);
    const extension = relative.slice(relative.lastIndexOf("."));
    const contentType = vendorContentTypes[extension];
    if (contentType && existsSync(file)) asset = [relative, contentType];
  }
  if (!asset) return null;
  const body = method === "HEAD" ? null : Bun.file(join(WEB_DIR, asset[0]));
  return new Response(body, {
    headers: {
      "content-type": asset[1],
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; frame-ancestors 'none'",
    },
  });
}

function voiceInstructions(row: any): string {
  const history = (db.query(`
    SELECT type,payload FROM events
    WHERE session_id=? AND type IN ('user','assistant')
    ORDER BY seq DESC LIMIT 8
  `).all(row.id) as any[]).reverse().map((event) => {
    const payload = JSON.parse(event.payload);
    const speaker = event.type === "user" ? "User" : "Agent";
    return `${speaker}: ${String(payload.text ?? "").slice(0, 1_500)}`;
  }).join("\n");
  return `You are the realtime voice interface for Pi Remote thread ${String(row.name)}. Keep your own replies brief and conversational. Delegate every substantive request to the client coding agent; do not attempt the work yourself and do not claim completion before the client reports it. You may acknowledge a delegation naturally while it runs. Relay client updates accurately and ask concise follow-up questions when the client needs information.${history ? `\n\nRecent thread transcript:\n${history}` : ""}`;
}

function uploadName(raw: string): string {
  const value = basename(raw).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!value || value === "." || value === "..") throw new Error("Valid file name required");
  return value.slice(0, 180);
}

function availableUploadPath(root: string, name: string): string {
  let candidate = join(root, name);
  if (!existsSync(candidate)) return candidate;
  const extension = extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  for (let index = 2; index < 10_000; index++) {
    candidate = join(root, `${stem}-${index}${extension}`);
    if (!existsSync(candidate)) return candidate;
  }
  return join(root, `${stem}-${crypto.randomUUID()}${extension}`);
}

async function storeUpload(req: Request, requestedName: string, root = INGESTION) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = availableUploadPath(root, uploadName(requestedName));
  const writer = Bun.file(path).writer();
  let size = 0;
  try {
    const reader = req.body?.getReader();
    if (reader) {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        writer.write(value);
      }
    }
    await writer.end();
    return { name: basename(path), path, size };
  } catch (cause) {
    try { await writer.end(); } catch {}
    if (existsSync(path)) unlinkSync(path);
    throw cause;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const REMOTE_UPLOAD_SCRIPT = `
import json, os, pathlib, sys
name = pathlib.Path(sys.argv[1]).name
root = pathlib.Path.home() / "ingestion"
root.mkdir(mode=0o700, parents=True, exist_ok=True)
os.chmod(root, 0o700)
stem, suffix = pathlib.Path(name).stem, pathlib.Path(name).suffix
path = root / name
index = 2
while path.exists():
    path = root / f"{stem}-{index}{suffix}"
    index += 1
try:
    size = 0
    with path.open("xb") as out:
        while True:
            chunk = sys.stdin.buffer.read(65536)
            if not chunk: break
            out.write(chunk)
            size += len(chunk)
    os.chmod(path, 0o600)
    print(json.dumps({"name": path.name, "path": str(path), "size": size}))
except BaseException:
    try: path.unlink()
    except OSError: pass
    raise
`;

async function storeWorkUpload(req: Request, requestedName: string, target: RemoteTarget) {
  const name = uploadName(requestedName);
  const command = `python3 -c ${shellQuote(REMOTE_UPLOAD_SCRIPT)} ${shellQuote(name)}`;
  const proc = Bun.spawn(["ssh", target.ssh, command], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  try {
    const reader = req.body?.getReader();
    if (reader) {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        proc.stdin.write(value);
      }
    }
    await proc.stdin.end();
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    if (code !== 0) throw new Error(stderr.trim() || `Work upload failed (${code})`);
    return JSON.parse(stdout.trim());
  } catch (cause) {
    try { proc.kill(); } catch {}
    throw cause;
  }
}

async function deleteWorkUpload(requestedName: string, target: RemoteTarget) {
  const name = uploadName(requestedName);
  const path = `${target.home}/ingestion/${name}`;
  const proc = Bun.spawn(["ssh", target.ssh, `rm -f -- ${shellQuote(path)}`], { stdout: "ignore", stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(stderr.trim() || `Could not remove work upload (${code})`);
}

const sessionRow = db.query("SELECT * FROM sessions WHERE id=?");
// Archived threads accumulate without bound, so every poll carries only the newest page;
// clients ask for older pages explicitly.
const ARCHIVED_PAGE_SIZE = 20;
const ARCHIVED_MAX_PAGE_SIZE = 100;
const archivedPageRows = db.query(
  "SELECT * FROM sessions WHERE archived_at IS NOT NULL ORDER BY archived_at DESC, id DESC LIMIT ? OFFSET ?",
);
const archivedCountRow = db.query("SELECT COUNT(*) AS total FROM sessions WHERE archived_at IS NOT NULL");
const archivedPage = (offset: number, limit: number) => archivedPageRows.all(limit, offset) as any[];
const archivedCount = () => Number((archivedCountRow.get() as any)?.total ?? 0);
const supervisorEpochRow = db.query("SELECT value FROM metadata WHERE key='supervisor_epoch'");
function ownsSupervisorLease(): boolean {
  try { return (supervisorEpochRow.get() as any)?.value === SUPERVISOR_EPOCH; }
  catch { return false; }
}

function emit(sessionId: string, type: string, payload: unknown = {}): number {
  if (!ownsSupervisorLease()) return 0;
  const time = now();
  const encoded = JSON.stringify(payload);
  const result = db.query("INSERT INTO events(session_id,time,type,payload) VALUES(?,?,?,?)")
    .run(sessionId, time, type, encoded);
  signalSync();
  return Number(result.lastInsertRowid);
}
function touchSession(id: string) {
  if (!ownsSupervisorLease()) return;
  db.query("UPDATE sessions SET revision=revision+1,updated_at=? WHERE id=?").run(now(), id);
  signalSync();
}
function confirmWorkInserted(sessionId: string, workId: string): number {
  if (!ownsSupervisorLease()) return 0;
  let sequence = 0;
  db.transaction(() => {
    const work = db.query("SELECT text,delivery,inserted_at FROM work_items WHERE id=? AND session_id=?").get(workId, sessionId) as any;
    if (!work || work.inserted_at) return;
    const time = now();
    const result = db.query("INSERT INTO events(session_id,time,type,payload) VALUES(?,?,?,?)")
      .run(sessionId, time, "user", JSON.stringify({ text: String(work.text), delivery: String(work.delivery), workId }));
    sequence = Number(result.lastInsertRowid);
    db.query("UPDATE work_items SET event_seq=?,inserted_at=?,updated_at=? WHERE id=? AND inserted_at IS NULL")
      .run(sequence, time, time, workId);
    db.query("UPDATE sessions SET revision=revision+1,updated_at=? WHERE id=?").run(time, sessionId);
  })();
  return sequence;
}
function confirmDispatchedWork(sessionId: string, delivery?: string, limit = Number.POSITIVE_INFINITY) {
  let confirmed = 0;
  for (const work of db.query(`
    SELECT id,delivery FROM work_items
    WHERE session_id=? AND state='dispatched' AND inserted_at IS NULL
    ORDER BY created_at,rowid
  `).all(sessionId) as any[]) {
    if (delivery ? work.delivery !== delivery : work.delivery === "steer") continue;
    confirmWorkInserted(sessionId, String(work.id));
    if (++confirmed >= limit) break;
  }
}
function setState(id: string, state: string, lastError: string | null = null) {
  if (!ownsSupervisorLease()) return;
  const row = sessionRow.get(id) as any;
  if (!row) return;
  if (row.state === state && (row.last_error ?? null) === lastError) return;
  db.query("UPDATE sessions SET state=?,updated_at=?,last_error=?,revision=revision+1 WHERE id=?")
    .run(state, now(), lastError, id);
}
function setRuntimePhase(id: string, rt: Runtime, phase: RuntimePhase, state?: string, lastError: string | null = null) {
  if (rt.phase !== phase) {
    rt.phase = phase;
    rt.phaseVersion++;
    touchSession(id);
  }
  if (state) setState(id, state, lastError);
}
function runtimeWorking(rt: Runtime | undefined): boolean {
  return !!rt && ["STARTING", "DISPATCHING", "RUNNING", "ABORTING"].includes(rt.phase);
}
function normalizeThreadName(value: string): string {
  const name = value.trim().replace(/\s+/g, " ");
  if (name.length < 3 || name.length > 60 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error("Thread title must be 3–60 characters");
  const words = name.split(" ");
  if (words.length < 2 || words.length > 3) throw new Error("Thread title must contain two or three words");
  if (/^\d+$/.test(name)) throw new Error("Thread title must not be numeric");
  return name;
}
function nextThreadName(): string {
  const current = Number((db.query("SELECT value FROM metadata WHERE key='last_thread_number'").get() as any)?.value ?? 0);
  const next = current + 1;
  db.query("UPDATE metadata SET value=? WHERE key='last_thread_number'").run(String(next));
  return String(next);
}

type AgentModelCount = { key: string; label: string; count: number };
const agentModelOrder = new Map(PROVIDER_MANIFEST.agentOrder.map((key, index) => [key, index]));
// The drawer presents work above this machine; the agent list presents this
// machine first. Both are views of the same hosts.
const AGENT_LOCATION_ORDER = ["work", "local"];

function addAgentModel(models: Map<string, AgentModelCount>, raw: string, count = 1) {
  if (count <= 0) return;
  const type = manifestAgentType(PROVIDER_MANIFEST, raw);
  const current = models.get(type.key);
  if (current) current.count += count;
  else models.set(type.key, { ...type, count });
}
function sortedAgentModels(models: Map<string, AgentModelCount>): AgentModelCount[] {
  return [...models.values()].sort((left, right) =>
    (agentModelOrder.get(left.key) ?? 999) - (agentModelOrder.get(right.key) ?? 999) || left.label.localeCompare(right.label));
}
// A Pi Remote thread runs where its execution target points, so a work thread
// belongs to the work machine's count even though its supervisor is here.
function runtimeHostKey(id: string): string {
  const row = sessionRow.get(id) as any;
  return row && row.execution_target !== "local" ? "work" : "local";
}
async function activeAgents() {
  const snapshots = new Map(await Promise.all(agentHosts.map(async (host) =>
    [host.key, await host.runs()] as const)));
  const runtimeModels = new Map(agentHosts.map((host) => [host.key, new Map<string, AgentModelCount>()]));
  const runtimeCounts = new Map(agentHosts.map((host) => [host.key, 0]));
  for (const [id, rt] of runtimes) if (runtimeWorking(rt)) {
    const key = runtimeHostKey(id);
    if (!runtimeCounts.has(key)) continue;
    runtimeCounts.set(key, runtimeCounts.get(key)! + 1);
    addAgentModel(runtimeModels.get(key)!, rt.modelId || "unknown");
  }
  const locations = agentHosts
    .map((host) => {
      const snapshot = snapshots.get(host.key)!;
      const models = new Map<string, AgentModelCount>();
      for (const row of snapshot.models) addAgentModel(models, row.model, row.count);
      for (const model of runtimeModels.get(host.key)!.values()) addAgentModel(models, model.key, model.count);
      return {
        key: host.key,
        label: host.ref.label,
        name: host.ref.name,
        total: snapshot.running + runtimeCounts.get(host.key)!,
        models: sortedAgentModels(models),
        updatedAt: snapshot.updatedAt,
        error: snapshot.error,
      };
    })
    .sort((left, right) => AGENT_LOCATION_ORDER.indexOf(left.key) - AGENT_LOCATION_ORDER.indexOf(right.key));
  const allModels = new Map<string, AgentModelCount>();
  for (const location of locations) for (const model of location.models) addAgentModel(allModels, model.key, model.count);
  const modelGroups = sortedAgentModels(allModels);
  const piRemote = [...runtimeCounts.values()].reduce((total, count) => total + count, 0);
  const orchestrator = [...snapshots.values()].reduce((total, snapshot) => total + snapshot.running, 0);
  return {
    total: piRemote + orchestrator,
    groups: [
      { key: "pi-remote", label: "REMOTE", count: piRemote },
      { key: "orchestrator", label: "ORCH", count: orchestrator },
      ...modelGroups,
    ],
    models: modelGroups,
    locations,
    sources: {
      piRemote,
      orchestrator,
      localOrchestrator: snapshots.get("local")?.running ?? 0,
      workOrchestrator: snapshots.get("work")?.running ?? 0,
    },
    updatedAt: now(),
  };
}

type PreparedQueue = { counts: Map<string, number>; messages: any[] };
function preparedQueues(rows: any[]): Map<string, PreparedQueue> {
  const wanted = new Set(rows.map((row) => String(row.id)));
  const prepared = new Map<string, PreparedQueue>();
  for (const id of wanted) prepared.set(id, { counts: new Map(), messages: [] });
  for (const item of db.query(`
    SELECT rowid queue_order,id,session_id,text,delivery,state,created_at,last_error,inserted_at
    FROM work_items WHERE state IN ('queued','running','dispatched') ORDER BY created_at,rowid
  `).all() as any[]) {
    const queue = prepared.get(String(item.session_id));
    if (!queue) continue;
    queue.counts.set(String(item.delivery), (queue.counts.get(String(item.delivery)) ?? 0) + (item.state === "dispatched" ? 0 : 1));
    if (!item.inserted_at && queue.messages.length < 50) queue.messages.push(item);
  }
  return prepared;
}

function publicSessions(rows: any[]): any[] {
  const queues = preparedQueues(rows);
  return rows.map((row) => publicSession(row, queues.get(String(row.id))));
}

function publicSession(row: any, prepared?: PreparedQueue) {
  const rt = runtimes.get(row.id);
  const preset = workspaces.get(row.workspace_id);
  const remoteTarget = REMOTE_TARGETS.get(row.execution_target) ?? null;
  const executionTarget = remoteTarget ? remoteTarget.id : "local";
  const profile = row.workspace_id === "hara" ? "personal" : executionTarget;
  const cwd = remoteTarget ? (row.remote_cwd || remoteTarget.cwd) : (preset?.path ?? row.workspace_id);
  const toolNames = rt ? [...rt.activeTools.values()] : [];
  const durableQueue = prepared ? [...prepared.counts].map(([delivery, count]) => ({ delivery, count })) : db.query(`
    SELECT delivery,count(*) count FROM work_items
    WHERE session_id=? AND state IN ('queued','running') GROUP BY delivery
  `).all(row.id) as any[];
  const durableSteering = Number(durableQueue.find((item) => item.delivery === "steer")?.count ?? 0);
  const durableFollowUps = Number(durableQueue.find((item) => item.delivery === "followUp")?.count ?? 0);
  const queuedSource = prepared?.messages ?? db.query(`
    SELECT id,text,delivery,state,created_at,last_error FROM work_items
    WHERE session_id=? AND state IN ('queued','running','dispatched') AND inserted_at IS NULL
    ORDER BY created_at,rowid LIMIT 50
  `).all(row.id) as any[];
  const queuedMessages = queuedSource.map((item) => ({
    id: item.id,
    text: String(item.text),
    delivery: String(item.delivery),
    state: String(item.state),
    status: item.state === "dispatched" ? "Sent · awaiting confirmation"
      : item.state === "running" ? "Sending to agent"
      : item.delivery === "steer" ? "Steering after current tool calls"
      : item.delivery === "followUp" ? "Queued for after completion"
      : "Sending to agent",
    canSteer: item.state === "queued" && item.delivery === "followUp",
    canCancel: item.state === "queued",
    createdAt: item.created_at,
    lastError: item.last_error,
  }));
  const activity = row.state === "FAILED" ? "FAILED"
    : rt?.phase === "STARTING" || row.state === "STARTING" ? "STARTING"
    : rt?.phase === "ABORTING" || rt?.phase === "STOPPING" || row.state === "ABORTING" ? "ABORTING"
    : rt?.compacting ? "COMPACTING"
    : rt?.retrying ? "RETRYING"
    : rt?.phase === "RUNNING" && toolNames.length ? "WAITING_ON_TOOL"
    : rt?.phase === "RUNNING" && rt.liveThinking ? "THINKING"
    : rt?.phase === "RUNNING" ? "WORKING"
    : rt?.phase === "DISPATCHING" || row.state === "RUNNING" ? "QUEUED"
    : "IDLE";
  return {
    id: row.id,
    name: row.name,
    cwd,
    workspaceName: remoteTarget ? remoteTarget.name : (preset?.name ?? cwd),
    environment: profile,
    state: row.state,
    activity,
    activeTool: toolNames.at(-1) ?? null,
    provider: String(row.current_provider ?? row.initial_provider ?? "").toLowerCase().startsWith("anthropic") ? "anthropic" : "openai",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: Number(row.revision ?? 0),
    lastError: row.last_error,
    steeringQueued: durableSteering + (rt?.steeringQueued ?? 0),
    followUpQueued: durableFollowUps + (rt?.followUpQueued ?? 0),
    queuedMessages,
    archivedAt: row.archived_at ?? null,
  };
}
function textFromMessage(message: any): string {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content.filter((x: any) => x?.type === "text").map((x: any) => x.text ?? "").join("");
}

function modelFailureText(message: any): string {
  if (!message || message.role !== "assistant") return "";
  const stopReason = String(message.stopReason ?? "");
  if (stopReason !== "error" && stopReason !== "aborted") return "";
  const rawStopReason = String(message.rawStopReason ?? "");
  const label = rawStopReason === "refusal"
    ? "Model refused the message"
    : stopReason === "aborted"
      ? "Model response aborted"
      : "Model response failed";
  const detail = String(message.errorMessage ?? "").trim();
  const text = detail ? `${label}: ${detail}` : label;
  return text.length <= 2_000 ? text : text.slice(0, 2_000) + "…";
}

function boundedJson(value: unknown, limit = 12_000): unknown {
  try {
    const encoded = JSON.stringify(value ?? {});
    if (encoded.length <= limit) return value ?? {};
    return { truncated: true, preview: encoded.slice(0, limit) + "…" };
  } catch { return { unavailable: true }; }
}
function toolResultText(result: any): string {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const parts = blocks.map((block: any) => {
    if (block?.type === "text") return String(block.text ?? "");
    if (block?.type === "image") return `[image${block.mimeType ? ` · ${block.mimeType}` : ""}]`;
    return block ? JSON.stringify(block) : "";
  }).filter(Boolean);
  const text = parts.join("\n");
  if (text.length <= 20_000) return text;
  return text.slice(0, 20_000) + "\n… output truncated in mobile transcript";
}

function sendLine(rt: Runtime, value: unknown) {
  rt.proc.stdin.write(JSON.stringify(value) + "\n");
  rt.proc.stdin.flush();
}

function signalRuntimeProcessGroup(rt: Runtime, signal: NodeJS.Signals) {
  try { process.kill(-rt.proc.pid, signal); }
  catch { try { rt.proc.kill(signal); } catch {} }
}

async function terminateRuntimeProcess(rt: Runtime, graceMs = 2_000) {
  const groupAlive = () => {
    try { process.kill(-rt.proc.pid, 0); return true; } catch { return false; }
  };
  signalRuntimeProcessGroup(rt, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (groupAlive() && Date.now() < deadline) await Bun.sleep(50);
  if (groupAlive()) signalRuntimeProcessGroup(rt, "SIGKILL");
  await Promise.race([rt.proc.exited.catch(() => {}), Bun.sleep(500)]);
}
class RpcTimeoutError extends Error {
  constructor(readonly command: string) { super(`${command} timed out`); this.name = "RpcTimeoutError"; }
}

function rpc(rt: Runtime, type: string, body: Record<string, unknown> = {}, timeoutMs = 15000): Promise<any> {
  const id = crypto.randomUUID();
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      rt.pending.delete(id);
      reject(new RpcTimeoutError(type));
    }, timeoutMs);
    rt.pending.set(id, { resolve, reject, timer });
    sendLine(rt, { id, type, ...body });
  });
  // Mark the rejection as handled at creation: a caller that forgets to await
  // or catch can never crash the supervisor (each crash orphans mid-turn RPC
  // children and re-dispatches their work — the double-agent bug class).
  // Awaiting callers still receive the rejection normally.
  promise.catch(() => {});
  return promise;
}

async function consumeLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    while (true) {
      const i = buffer.indexOf("\n");
      if (i < 0) break;
      let line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line) onLine(line);
    }
  }
  buffer += decoder.decode();
  if (buffer) onLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
}

function handleRpcEvent(sessionId: string, rt: Runtime, event: any) {
  if (event.type === "response" && event.id) {
    const pending = rt.pending.get(event.id);
    if (pending) {
      clearTimeout(pending.timer);
      rt.pending.delete(event.id);
      event.success ? pending.resolve(event.data ?? {}) : pending.reject(new Error(event.error ?? "RPC command failed"));
    }
    return;
  }
  if (!ownsSupervisorLease() || runtimes.get(sessionId) !== rt || rt.phase === "STOPPING") return;
  if (event.type === "queue_update") {
    const steering = Array.isArray(event.steering) ? event.steering.length : 0;
    const followUp = Array.isArray(event.followUp) ? event.followUp.length : 0;
    if (steering > rt.steeringQueued) confirmDispatchedWork(sessionId, "steer", steering - rt.steeringQueued);
    if (followUp > rt.followUpQueued) confirmDispatchedWork(sessionId, "followUp", followUp - rt.followUpQueued);
    if (steering !== rt.steeringQueued || followUp !== rt.followUpQueued) {
      rt.steeringQueued = steering;
      rt.followUpQueued = followUp;
      rt.phaseVersion++;
      touchSession(sessionId);
    }
    return;
  }
  // Abort owns the lifecycle transition, but Pi can finish already accepted
  // steering before abort() returns. Keep those real transcript events; only a
  // process that is actually stopping suppresses output.
  if (rt.phase === "STOPPING" || rt.suppressOutput) return;
  // Any agent event invalidates an in-flight get_state snapshot taken before it.
  rt.phaseVersion++;

  const proveRunning = () => {
    confirmDispatchedWork(sessionId);
    if (["STARTING", "IDLE", "DISPATCHING"].includes(rt.phase)) {
      setRuntimePhase(sessionId, rt, "RUNNING", "RUNNING");
    }
  };
  if (event.type === "agent_start") {
    proveRunning();
  } else if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
    proveRunning();
    rt.liveText += event.assistantMessageEvent.delta ?? "";
  } else if (event.type === "message_update" && event.assistantMessageEvent?.type === "thinking_start") {
    proveRunning();
    rt.liveThinking = "";
    touchSession(sessionId);
  } else if (event.type === "message_update" && event.assistantMessageEvent?.type === "thinking_delta") {
    proveRunning();
    rt.liveThinking += event.assistantMessageEvent.delta ?? "";
  } else if (event.type === "message_update" && event.assistantMessageEvent?.type === "thinking_end") {
    const thinking = rt.liveThinking || String(event.assistantMessageEvent.content ?? "");
    if (thinking) emit(sessionId, "thinking", { text: thinking });
    rt.liveThinking = "";
    touchSession(sessionId);
  } else if (event.type === "message_end") {
    proveRunning();
    const text = textFromMessage(event.message);
    if (text) emit(sessionId, "assistant", { text });
    const failure = modelFailureText(event.message);
    if (failure) rt.pendingModelFailure = failure;
    else if (event.message?.role === "assistant") rt.pendingModelFailure = null;
    if (rt.liveThinking) emit(sessionId, "thinking", { text: rt.liveThinking });
    rt.liveText = "";
    rt.liveThinking = "";
  } else if (event.type === "tool_execution_start") {
    proveRunning();
    const toolCallId = String(event.toolCallId ?? crypto.randomUUID());
    const name = String(event.toolName ?? "tool");
    rt.activeTools.set(toolCallId, name);
    touchSession(sessionId);
    emit(sessionId, "tool_start", { toolCallId, name, args: boundedJson(event.args) });
  } else if (event.type === "tool_execution_end") {
    const toolCallId = String(event.toolCallId ?? "");
    rt.activeTools.delete(toolCallId);
    touchSession(sessionId);
    emit(sessionId, "tool_end", {
      toolCallId,
      name: String(event.toolName ?? "tool"),
      output: toolResultText(event.result),
      error: Boolean(event.isError),
    });
  } else if (event.type === "auto_retry_start") {
    rt.retrying = true;
    touchSession(sessionId);
    emit(sessionId, "notice", { text: "Retrying…" });
  } else if (event.type === "auto_retry_end") {
    rt.retrying = false;
    touchSession(sessionId);
    if (!event.success && event.finalError) emit(sessionId, "notice", { text: `Retry failed: ${String(event.finalError)}` });
  } else if (event.type === "compaction_start") {
    rt.compacting = true;
    touchSession(sessionId);
    emit(sessionId, "notice", { text: "Compacting context…" });
  } else if (event.type === "compaction_end") {
    rt.compacting = false;
    touchSession(sessionId);
    const text = event.aborted
      ? "Context compaction cancelled"
      : event.result
        ? "Context compacted"
        : event.willRetry
          ? "Context compaction failed; retrying…"
          : `Context compaction failed${event.errorMessage ? `: ${String(event.errorMessage)}` : ""}`;
    emit(sessionId, "notice", { text });
  } else if (event.type === "extension_error") {
    emit(sessionId, "notice", { text: "Extension error" });
  } else if (event.type === "extension_ui_request") {
    if (["select", "confirm", "input", "editor"].includes(event.method)) {
      sendLine(rt, { type: "extension_ui_response", id: event.id, cancelled: true });
      emit(sessionId, "notice", { text: "An interactive extension dialog was cancelled on mobile." });
    }
  } else if (event.type === "agent_settled") {
    if (rt.phase === "DISPATCHING" && rt.dispatchedWorkIds.size > 0) {
      emit(sessionId, "notice", { text: "Ignored a stale settled event while the new message was starting" });
    } else if (rt.phase === "RUNNING") {
      settleRuntime(sessionId, rt, true);
    }
  }
}

function settleRuntime(sessionId: string, rt: Runtime, emitEvent: boolean): boolean {
  if (rt.phase !== "RUNNING") return false;
  if (rt.pendingModelFailure) emit(sessionId, "notice", { text: rt.pendingModelFailure });
  rt.pendingModelFailure = null;
  setRuntimePhase(sessionId, rt, "IDLE");
  rt.compacting = false;
  rt.retrying = false;
  rt.activeTools.clear();
  rt.steeringQueued = 0;
  rt.followUpQueued = 0;
  rt.liveText = "";
  rt.liveThinking = "";
  rt.lastActivity = Date.now();
  if (rt.dispatchedWorkIds.size > 0) {
    const completedAt = now();
    for (const workId of rt.dispatchedWorkIds) {
      db.query("UPDATE work_items SET state='complete',updated_at=?,last_error=NULL WHERE id=? AND state='dispatched'")
        .run(completedAt, workId);
    }
    rt.dispatchedWorkIds.clear();
  }
  const pendingWork = Number((db.query(
    "SELECT COUNT(*) count FROM work_items WHERE session_id=? AND state IN ('queued','running')",
  ).get(sessionId) as any)?.count ?? 0);
  setState(sessionId, pendingWork > 0 ? "RUNNING" : "IDLE");
  if (emitEvent) emit(sessionId, "settled");
  kickSession(sessionId);
  return true;
}

async function reconcileRuntimeState(sessionId: string, rt: Runtime): Promise<any> {
  if (rt.reconciling || ["ABORTING", "STOPPING"].includes(rt.phase)) return null;
  rt.reconciling = true;
  const phaseVersion = rt.phaseVersion;
  try {
    const state = await rpc(rt, "get_state", {}, 5_000);
    if (!ownsSupervisorLease() || runtimes.get(sessionId) !== rt || rt.phaseVersion !== phaseVersion) return state;
    if (state.model?.id) rt.modelId = String(state.model.id);
    if (state.model?.provider) {
      const row = sessionRow.get(sessionId) as any;
      if (row && row.current_provider !== String(state.model.provider)) {
        db.query("UPDATE sessions SET current_provider=?,revision=revision+1,updated_at=? WHERE id=?")
          .run(String(state.model.provider), now(), sessionId);
      }
    }
    const active = Boolean(state.isStreaming || state.isCompacting || Number(state.pendingMessageCount ?? 0) > 0);
    rt.compacting = Boolean(state.isCompacting);
    if (active) {
      if (["IDLE", "DISPATCHING"].includes(rt.phase)) setRuntimePhase(sessionId, rt, "RUNNING", "RUNNING");
    } else if (rt.phase === "RUNNING") {
      settleRuntime(sessionId, rt, true);
    } else if (rt.phase === "IDLE") {
      const pendingWork = Number((db.query(
        "SELECT COUNT(*) AS count FROM work_items WHERE session_id=? AND state IN ('queued','running','dispatched')",
      ).get(sessionId) as any)?.count ?? 0);
      setState(sessionId, pendingWork > 0 ? "RUNNING" : "IDLE");
    }
    // DISPATCHING + inactive is intentionally not settlement: a get_state request
    // can sample the gap between prompt acknowledgement and agent_start.
    return state;
  } finally {
    rt.reconciling = false;
  }
}

async function startRuntime(row: any): Promise<Runtime> {
  const remoteTarget = REMOTE_TARGETS.get(row.execution_target) ?? null;
  const isWork = remoteTarget !== null;
  const preset = workspaces.get(row.workspace_id);
  const cwd = isWork ? realpathSync(WORK_SHADOW) : realpathSync(preset?.path ?? row.workspace_id);
  const resumePath = row.session_path && existsSync(row.session_path) ? row.session_path : null;
  if (row.session_path && !resumePath) {
    db.query("UPDATE sessions SET session_path=NULL WHERE id=?").run(row.id);
    emit(row.id, "notice", { text: "Session file was missing; restoring from saved conversation history" });
  }
  writeServiceTier(row.id, row.service_tier === "priority" ? "priority" : "default");
  const args = [
    NICE, "-n", "10", PI, "--mode", "rpc", "--session-dir", join(DATA, "sessions"),
    "--extension", SERVICE_TIER_EXTENSION,
    "--extension", THREAD_CONTEXT_EXTENSION,
  ];
  if (isWork) args.push("--no-context-files", "--extension", WORK_EXTENSION);
  if (resumePath) args.push("--session", resumePath);
  else {
    args.push("--name", row.name);
    if (row.initial_provider && row.initial_model) {
      args.push("--provider", row.initial_provider, "--model", row.initial_model);
    }
    if (row.initial_thinking) args.push("--thinking", row.initial_thinking);
  }
  setState(row.id, "STARTING");
  const proc = Bun.spawn(args, {
    cwd,
    detached: true,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      HOME,
      PATH: `${join(HOME, ".local/bin")}:${join(HOME, ".bun/bin")}:${process.env.PATH ?? ""}`,
      PI_REMOTE_SESSION_ID: row.id,
      PI_REMOTE_SERVICE_TIER_FILE: serviceTierPath(row.id),
      PI_REMOTE_SERVER_URL: `http://${HOST}:${PORT}`,
      PI_REMOTE_EXECUTION_TARGET: remoteTarget?.id ?? "local",
      PI_REMOTE_WORK_SSH: remoteTarget?.ssh ?? "",
      PI_REMOTE_WORK_HOME: remoteTarget?.home ?? "",
      PI_REMOTE_WORK_CWD: row.remote_cwd || remoteTarget?.cwd || "",
      PI_REMOTE_WORK_NAME: remoteTarget?.name ?? "Remote host",
      PI_CODING_AGENT_DIR: AGENT_DIR,
    },
  });
  const rt: Runtime = {
    proc,
    pending: new Map(),
    phase: "STARTING",
    phaseVersion: 0,
    compacting: false,
    retrying: false,
    reconciling: false,
    suppressOutput: false,
    liveText: "",
    liveThinking: "",
    pendingModelFailure: null,
    expectedExit: false,
    lastActivity: Date.now(),
    activeTools: new Map(),
    dispatchedWorkIds: new Set(),
    steeringQueued: 0,
    followUpQueued: 0,
    historyNeedsRestore: false,
    modelId: String(row.initial_model ?? "unknown"),
  };
  runtimes.set(row.id, rt);
  consumeLines(proc.stdout, (line) => {
    try { handleRpcEvent(row.id, rt, JSON.parse(line)); }
    catch { emit(row.id, "notice", { text: "Malformed agent event ignored" }); }
  });
  consumeLines(proc.stderr, (line) => {
    const clean = line.replaceAll(HOME, "~").slice(0, 500);
    if (clean) console.error(`[pi ${row.id}] ${clean}`);
  });
  proc.exited.then((code) => {
    for (const pending of rt.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Agent stopped")); }
    rt.pending.clear();
    if (runtimes.get(row.id) !== rt) return;
    setRuntimePhase(row.id, rt, "STOPPING");
    runtimes.delete(row.id);
    if (shuttingDown || !ownsSupervisorLease()) return;
    const retryAt = Date.now() + 2_000;
    db.query("UPDATE work_items SET state='queued',resume=1,available_at=?,updated_at=?,last_error='Agent stopped before settling' WHERE session_id=? AND state='dispatched'")
      .run(retryAt, now(), row.id);
    rt.dispatchedWorkIds.clear();
    // A database migration or operator recovery may remove the row before process exit arrives.
    if (!sessionRow.get(row.id)) return;
    const pendingWork = Number((db.query(
      "SELECT COUNT(*) count FROM work_items WHERE session_id=? AND state IN ('queued','running')",
    ).get(row.id) as any)?.count ?? 0);
    if (rt.expectedExit) {
      setState(row.id, "STOPPED");
    } else if (pendingWork > 0) {
      setState(row.id, "RUNNING", `Agent exited ${code}; resuming queued work`);
      emit(row.id, "notice", { text: `Agent disconnected (exit ${code}); resuming queued work` });
      scheduleSession(row.id, 2_000);
    } else {
      setState(row.id, "STOPPED", code === 0 ? null : `Agent exited ${code}`);
      emit(row.id, "notice", { text: `Agent disconnected while idle (exit ${code}); thread remains resumable` });
    }
  });
  try {
    const state = await rpc(rt, "get_state", {}, 120_000);
    if (!ownsSupervisorLease() || rt.phase !== "STARTING") throw new Error("Activation cancelled");
    if (state.model?.id) rt.modelId = String(state.model.id);
    if (state.sessionFile) db.query("UPDATE sessions SET session_path=? WHERE id=?").run(state.sessionFile, row.id);
    if (state.model?.provider) db.query("UPDATE sessions SET current_provider=?,revision=revision+1,updated_at=? WHERE id=?")
      .run(String(state.model.provider), now(), row.id);
    const historyCount = (db.query("SELECT count(*) count FROM events WHERE session_id=? AND type IN ('user','assistant')").get(row.id) as any)?.count ?? 0;
    rt.historyNeedsRestore = Number(state.messageCount ?? 0) === 0 && historyCount > 0;
    const pendingWork = Number((db.query(
      "SELECT COUNT(*) AS count FROM work_items WHERE session_id=? AND state IN ('queued','running')",
    ).get(row.id) as any)?.count ?? 0);
    setRuntimePhase(row.id, rt, "IDLE", pendingWork > 0 ? "RUNNING" : "IDLE");
    if (rt.historyNeedsRestore) emit(row.id, "notice", { text: "Conversation context will be restored with the next message" });
    return rt;
  } catch (cause) {
    const cancelled = rt.expectedExit;
    rt.expectedExit = true;
    setRuntimePhase(row.id, rt, "STOPPING");
    await terminateRuntimeProcess(rt);
    if (cancelled || !ownsSupervisorLease()) throw cause;
    if (resumePath) {
      db.query("UPDATE sessions SET session_path=NULL WHERE id=?").run(row.id);
      emit(row.id, "notice", { text: "Session could not resume; restoring from saved conversation history" });
      return startRuntime({ ...row, session_path: null });
    }
    throw cause;
  }
}

async function activate(row: any): Promise<Runtime> {
  const current = sessionRow.get(row.id) as any;
  if (!current || current.archived_at) throw new Error("Thread is archived; unarchive it before continuing");
  row = current;
  const inProgress = activations.get(row.id);
  if (inProgress) return inProgress;
  const existing = runtimes.get(row.id);
  if (existing) return existing;
  const activation = startRuntime(row).finally(() => { activations.delete(row.id); });
  activations.set(row.id, activation);
  return activation;
}

function canonicalModelProvider(provider: string): string {
  if (/^openai-codex(?:-\d+)?$/.test(provider)) return "openai-codex";
  if (/^anthropic(?:-\d+)?$/.test(provider)) return "anthropic";
  return provider;
}

function commonModelRank(model: any): number {
  if (model.provider === "anthropic" && model.id === "claude-fable-5") return 0;
  if (model.provider === "anthropic" && model.id === "claude-opus-5") return 1;
  if (model.provider === "openai-codex" && /^gpt-5\.6(?:-|$)/.test(model.id)) return 2;
  return Number.POSITIVE_INFINITY;
}

function rolledUpModels(rows: any[]): any[] {
  const unique = new Map<string, any>();
  for (const source of rows) {
    const provider = canonicalModelProvider(String(source?.provider ?? ""));
    const id = String(source?.id ?? "");
    if (!provider || !id) continue;
    const key = `${provider}\u0000${id}`;
    const candidate = { ...source, provider };
    const existing = unique.get(key);
    if (!existing || source.provider === provider) unique.set(key, candidate);
  }
  return [...unique.values()].map((model) => ({ ...model, common: Number.isFinite(commonModelRank(model)) }))
    .sort((left, right) => {
      const leftRank = commonModelRank(left), rightRank = commonModelRank(right);
      if (leftRank !== rightRank) return leftRank - rightRank;
      return String(left.name ?? left.id).localeCompare(String(right.name ?? right.id));
    });
}

const BUILTIN_COMMANDS = [{
  name: "compact",
  description: "Compact the current conversation context",
  source: "builtin",
}];

async function threadCommands(row: any) {
  const rt = await activate(row);
  const result = await rpc(rt, "get_commands");
  const commands = Array.isArray(result.commands) ? result.commands : [];
  const names = new Set(commands.map((command: any) => String(command?.name ?? "")));
  return { commands: [
    ...BUILTIN_COMMANDS,
    ...commands.filter((command: any) => !names.has("compact") || String(command?.name ?? "") !== "compact"),
  ] };
}

async function runCommand(row: any, requestId: string, name: string, args: string) {
  const old = requestResult(requestId);
  if (old) return { response: JSON.parse(old.response), status: old.status };
  if (!/^[a-zA-Z0-9:_-]+$/.test(name)) throw new Error("Invalid slash command");
  const rt = await activate(row);
  if (["ABORTING", "STOPPING"].includes(rt.phase)) throw new Error("Thread is stopping; wait for it to become resumable");
  const available = await threadCommands(row);
  const command = available.commands.find((candidate: any) => String(candidate.name) === name);
  if (!command) throw new Error(`Unknown slash command: /${name}`);
  const text = `/${name}${args ? ` ${args}` : ""}`;
  if (name === "compact") {
    const pendingWork = Number((db.query(
      "SELECT COUNT(*) AS count FROM work_items WHERE session_id=? AND state IN ('queued','running','dispatched')",
    ).get(row.id) as any)?.count ?? 0);
    if (rt.phase !== "IDLE" || pendingWork > 0) throw new Error("Wait for the thread to become idle before compacting");
    setRuntimePhase(row.id, rt, "DISPATCHING", "RUNNING");
    try {
      await rpc(rt, "compact", args ? { customInstructions: args } : {}, 120_000);
      if (rt.phase === "DISPATCHING") setRuntimePhase(row.id, rt, "RUNNING", "RUNNING");
      if (rt.phase === "RUNNING") settleRuntime(row.id, rt, true);
    } catch (cause) {
      if (rt.phase === "DISPATCHING") setRuntimePhase(row.id, rt, "IDLE", "IDLE");
      throw cause;
    }
  } else {
    const startsAgent = command.source === "prompt" || command.source === "skill";
    if (startsAgent) {
      if (rt.phase !== "IDLE") throw new Error("Wait for the thread to become idle before running this command");
      setRuntimePhase(row.id, rt, "DISPATCHING", "RUNNING");
    }
    try {
      await rpc(rt, "prompt", { message: text }, PROMPT_ACK_TIMEOUT_MS);
    } catch (cause) {
      if (startsAgent && rt.phase === "DISPATCHING") setRuntimePhase(row.id, rt, "IDLE", "IDLE");
      throw cause;
    }
    if (startsAgent) {
      const state = await reconcileRuntimeState(row.id, rt);
      if (state && !state.isStreaming && !state.isCompacting && !Number(state.pendingMessageCount ?? 0)
        && (rt.phase === "RUNNING" || rt.phase === "DISPATCHING")) {
        if (rt.phase === "DISPATCHING") setRuntimePhase(row.id, rt, "RUNNING", "RUNNING");
        settleRuntime(row.id, rt, true);
      }
    }
  }
  const response = { accepted: true, command: name, session: publicSession(sessionRow.get(row.id)) };
  saveRequest(requestId, row.id, "command", 202, response);
  return { response, status: 202 };
}

async function threadSettings(row: any) {
  const rt = await activate(row);
  const [state, availableModels, availableThinking] = await Promise.all([
    rpc(rt, "get_state"),
    rpc(rt, "get_available_models"),
    rpc(rt, "get_available_thinking_levels"),
  ]);
  if (!ownsSupervisorLease()) throw new Error("Supervisor instance was replaced");
  rt.lastActivity = Date.now();
  const model = state.model ? { ...state.model, provider: canonicalModelProvider(String(state.model.provider ?? "")) } : null;
  if (state.model?.id) rt.modelId = String(state.model.id);
  if (state.model?.provider && row.current_provider !== String(state.model.provider)) {
    db.query("UPDATE sessions SET current_provider=?,revision=revision+1,updated_at=? WHERE id=?")
      .run(String(state.model.provider), now(), row.id);
  }
  const latest = sessionRow.get(row.id) as any;
  const supportsPriority = String(state.model?.provider ?? latest?.current_provider ?? "").startsWith("openai");
  const models = rolledUpModels(availableModels.models ?? []);
  return {
    model,
    thinkingLevel: state.thinkingLevel ?? "off",
    speedMode: latest?.service_tier === "priority" ? "priority" : "normal",
    speedModes: supportsPriority ? ["normal", "priority"] : [],
    models,
    thinkingLevels: availableThinking.levels ?? ["off"],
  };
}

async function readBody(req: Request): Promise<any> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) throw new Error("application/json required");
  const text = await req.text();
  return JSON.parse(text || "{}");
}
function requestResult(requestId: string) {
  return db.query("SELECT status,response FROM requests WHERE request_id=?").get(requestId) as any;
}
function saveRequest(requestId: string, sessionId: string, kind: string, status: number, response: unknown) {
  db.query("INSERT OR IGNORE INTO requests VALUES(?,?,?,?,?,?)")
    .run(requestId, sessionId, kind, status, JSON.stringify(response), now());
}

function restoredContext(sessionId: string, beforeSeq: number, limit = 120_000): string {
  const rows = db.query(`
    SELECT type,payload FROM events
    WHERE session_id=? AND seq<? AND type IN ('user','assistant')
    ORDER BY seq DESC LIMIT 100
  `).all(sessionId, beforeSeq) as any[];
  const parts = rows.reverse().map((event) => {
    const payload = JSON.parse(event.payload);
    return `${event.type === "user" ? "USER" : "ASSISTANT"}: ${String(payload.text ?? "")}`;
  });
  let value = parts.join("\n\n");
  if (value.length > limit) value = "[Earlier context omitted]\n" + value.slice(-limit);
  return value;
}

function scheduleSession(sessionId: string, delayMs: number) {
  const session = sessionRow.get(sessionId) as any;
  if (!session || session.archived_at) return;
  const old = retryTimers.get(sessionId);
  if (old) clearTimeout(old);
  const timer = setTimeout(() => {
    retryTimers.delete(sessionId);
    kickSession(sessionId);
  }, Math.max(0, delayMs));
  retryTimers.set(sessionId, timer);
}

async function drainSession(sessionId: string) {
  while (true) {
    if (!ownsSupervisorLease()) return;
    const knownRuntime = runtimes.get(sessionId);
    const runtimeBusy = knownRuntime && ["DISPATCHING", "RUNNING"].includes(knownRuntime.phase);
    const item = db.query(`
      SELECT * FROM work_items
      WHERE session_id=? AND state='queued' AND available_at<=?
        ${runtimeBusy ? "AND delivery='steer'" : ""}
      ORDER BY created_at,rowid LIMIT 1
    `).get(sessionId, Date.now()) as any;
    if (!item) return;
    db.query("UPDATE work_items SET state='running',updated_at=? WHERE id=?").run(now(), item.id);
    try {
      const row = sessionRow.get(sessionId) as any;
      if (!row || row.archived_at) return;
      const rt = await activate(row);
      if (!ownsSupervisorLease()) return;
      // Abort can run while this worker is suspended in activation. Re-check the
      // durable claim before changing runtime phase or consuming restore context.
      const current = db.query("SELECT state FROM work_items WHERE id=?").get(item.id) as any;
      if (current?.state !== "running") continue;
      if (item.delivery === "followUp" && ["DISPATCHING", "RUNNING"].includes(rt.phase)) {
        db.query("UPDATE work_items SET state='queued',updated_at=? WHERE id=? AND state='running'").run(now(), item.id);
        return;
      }
      let message = item.text;
      if (rt.historyNeedsRestore) {
        const beforeSeq = Number((db.query("SELECT coalesce(max(seq),0)+1 before_seq FROM events WHERE session_id=?").get(sessionId) as any)?.before_seq ?? 1);
        const context = restoredContext(sessionId, beforeSeq);
        if (context) {
          message = item.resume
            ? `This Pi thread was interrupted and is being restored from its durable conversation ledger. Continue the unfinished work for the final user request in the transcript. Do not repeat completed actions or merely summarize the transcript.\n\n<prior_conversation>\n${context}\n</prior_conversation>`
            : `This Pi thread is being restored from its durable conversation ledger. Use the transcript below as prior context. Do not summarize or respond to the transcript itself; answer only the new user message after it.\n\n<prior_conversation>\n${context}\n</prior_conversation>\n\n<new_user_message>\n${item.text}\n</new_user_message>`;
        }
        rt.historyNeedsRestore = false;
      } else if (item.resume) {
        message = `The previous agent operation was interrupted after this request entered the conversation. Continue its unfinished work from the current session state without repeating completed actions.\n\n<interrupted_user_request>\n${item.text}\n</interrupted_user_request>`;
      }
      if (["ABORTING", "STOPPING"].includes(rt.phase)) return;
      rt.retrying = false;
      const wasBusy = rt.phase === "DISPATCHING" || rt.phase === "RUNNING";
      if (!wasBusy) {
        rt.liveText = "";
        rt.liveThinking = "";
        setRuntimePhase(sessionId, rt, "DISPATCHING", "RUNNING");
      } else {
        setState(sessionId, "RUNNING");
      }
      rt.lastActivity = Date.now();
      const delivery = item.delivery === "steer" ? "steer" : "followUp";
      const commandType = wasBusy ? (delivery === "steer" ? "steer" : "follow_up") : "prompt";
      db.query("UPDATE work_items SET state='dispatched',updated_at=?,last_error=NULL WHERE id=?").run(now(), item.id);
      rt.dispatchedWorkIds.add(item.id);
      rt.phaseVersion++;
      // A Pi steering/follow-up queue continues inside the current agent run and does
      // not emit a fresh agent_start. The phase remains RUNNING for queued messages;
      // only an idle prompt enters DISPATCHING until agent_start proves the new run.
      await rpc(rt, commandType, { message }, PROMPT_ACK_TIMEOUT_MS);
      confirmWorkInserted(sessionId, item.id);
    } catch (cause: any) {
      if (!ownsSupervisorLease()) return;
      const active = runtimes.get(sessionId);
      const latest = db.query("SELECT state FROM work_items WHERE id=?").get(item.id) as any;
      const session = sessionRow.get(sessionId) as any;
      if (!active && String(session?.last_error ?? "").includes("resuming queued work")) {
        if (latest?.state === "running") {
          db.query("UPDATE work_items SET state='queued',available_at=?,updated_at=?,last_error='Agent stopped before dispatch' WHERE id=?")
            .run(Date.now() + 2_000, now(), item.id);
        }
        scheduleSession(sessionId, 2_000);
        return;
      }
      if (cause instanceof RpcTimeoutError && ["prompt", "steer", "follow_up"].includes(cause.command) && active && latest?.state === "dispatched") {
        // stdin was written successfully, so a missing acknowledgement is ambiguous:
        // Pi may already be running or have queued the message. Keep exactly one
        // dispatched copy and let settled/process-exit reconciliation decide.
        setState(sessionId, "RUNNING", "Prompt acknowledgement delayed; monitoring Pi without resending");
        emit(sessionId, "notice", { text: "Prompt acknowledgement delayed; monitoring Pi without resending" });
        return;
      }
      if (["cancelled", "complete"].includes(String(latest?.state ?? ""))) {
        active?.dispatchedWorkIds.delete(item.id);
        return;
      }
      if (active?.phase === "DISPATCHING") setRuntimePhase(sessionId, active, "IDLE");
      active?.dispatchedWorkIds.delete(item.id);
      const attempts = Number(item.attempts ?? 0) + 1;
      const delay = Math.min(300_000, 5_000 * (2 ** Math.min(6, attempts - 1)));
      db.query("UPDATE work_items SET state='queued',attempts=?,available_at=?,updated_at=?,last_error=? WHERE id=?")
        .run(attempts, Date.now() + delay, now(), String(cause?.message ?? cause), item.id);
      const retryError = `Queued work retrying: ${String(cause?.message ?? cause)}`;
      setState(sessionId, active?.phase === "RUNNING" ? "RUNNING" : "FAILED", retryError);
      if (active) { active.retrying = true; touchSession(sessionId); }
      emit(sessionId, "notice", { text: `Message retained; retrying in ${Math.round(delay / 1000)} seconds` });
      scheduleSession(sessionId, delay);
      return;
    }
  }
}

function kickSession(sessionId: string) {
  const session = sessionRow.get(sessionId) as any;
  if (!session || session.archived_at || sessionWorkers.has(sessionId)) return;
  const worker = drainSession(sessionId)
    .catch((cause) => console.error(`Session worker ${sessionId} failed`, cause))
    .finally(() => {
      sessionWorkers.delete(sessionId);
      const rt = runtimes.get(sessionId);
      const busy = rt && ["DISPATCHING", "RUNNING"].includes(rt.phase);
      const next = db.query(`
        SELECT min(available_at) available_at FROM work_items
        WHERE session_id=? AND state='queued' ${busy ? "AND delivery='steer'" : ""}
      `).get(sessionId) as any;
      if (next?.available_at != null) scheduleSession(sessionId, Math.max(0, Number(next.available_at) - Date.now()));
    });
  sessionWorkers.set(sessionId, worker);
}

function enqueuePrompt(sessionId: string, requestId: string, text: string, delivery: "steer" | "followUp") {
  const workId = crypto.randomUUID();
  const time = now();
  const activeWork = Number((db.query("SELECT count(*) count FROM work_items WHERE session_id=? AND state IN ('queued','running','dispatched')").get(sessionId) as any)?.count ?? 0);
  const phase = runtimes.get(sessionId)?.phase;
  const queuedBehindWork = phase === "DISPATCHING" || phase === "RUNNING" || activeWork > 0;
  const effectiveDelivery = queuedBehindWork ? delivery : "prompt";
  db.query("INSERT INTO work_items(id,session_id,request_id,event_seq,text,delivery,state,attempts,available_at,created_at,updated_at,last_error,inserted_at) VALUES(?,?,?,?,?,?,'queued',0,?,?,?,NULL,NULL)")
    .run(workId, sessionId, requestId, 0, text, effectiveDelivery, Date.now(), time, time);
  setState(sessionId, "RUNNING");
  const response = {
    accepted: true,
    queued: queuedBehindWork,
    delivery: effectiveDelivery,
    workId,
    session: publicSession(sessionRow.get(sessionId)),
  };
  saveRequest(requestId, sessionId, "prompt", 202, response);
  kickSession(sessionId);
  return response;
}

function recoverUnansweredPrompts() {
  const rows = db.query(`
    SELECT e.session_id,e.seq,e.payload
    FROM events e JOIN sessions s ON s.id=e.session_id
    WHERE e.type='user' AND s.archived_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM events later WHERE later.session_id=e.session_id AND later.seq>e.seq AND later.type IN ('assistant','settled'))
      AND NOT EXISTS (SELECT 1 FROM work_items work WHERE work.event_seq=e.seq)
    ORDER BY e.seq
  `).all() as any[];
  for (const event of rows) {
    const payload = JSON.parse(event.payload);
    const text = String(payload.text ?? "").trim();
    if (!text) continue;
    const delivery = payload.delivery === "steer" ? "steer" : "followUp";
    const time = now();
    db.query("INSERT OR IGNORE INTO work_items(id,session_id,request_id,event_seq,text,delivery,state,attempts,available_at,created_at,updated_at,last_error,inserted_at) VALUES(?,?,?,?,?,?,'queued',0,?,?,?,NULL,?)")
      .run(crypto.randomUUID(), event.session_id, `recovered-${event.seq}`, event.seq, text, delivery, Date.now(), time, time, time);
  }
}

recoverUnansweredPrompts();

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  idleTimeout: 30,
  async fetch(req) {
    const url = new URL(req.url);
    if (!ownsSupervisorLease()) return error("Supervisor instance was replaced", 503);
    const deliveredFile = await sessionFileResponse(url, req.method, req);
    if (deliveredFile) return deliveredFile;
    const web = webResponse(url.pathname, req.method);
    if (web) return web;
    if (url.pathname === "/v1/health") return json({ ok: true, version: VERSION, environmentId: ENVIRONMENT_ID });
    if (url.pathname === "/v1/environment" && req.method === "GET") return json({ environment: environmentMetadata() });
    if (url.pathname === "/v1/voice" && req.method === "GET") {
      return json({ ...voiceAccounts.status(), model: DEFAULT_LIVE_MODEL, voice: DEFAULT_LIVE_VOICE });
    }
    if (url.pathname === "/v1/voice/offer" && req.method === "POST") {
      const sessionId = url.searchParams.get("sessionId") ?? "";
      const row = sessionRow.get(sessionId) as any;
      if (!row) return error("Session not found", 404);
      if (row.archived_at) return error("Thread is archived", 409);
      const result = await voiceAccounts.negotiate(await req.text(), voiceInstructions(row));
      if (!result.ok) return error(result.error, result.status);
      return new Response(result.sdp, {
        status: 201,
        headers: {
          "content-type": "application/sdp",
          "cache-control": "no-store",
          "x-pi-voice-account": result.account,
        },
      });
    }
    if (url.pathname === "/v1/thread-starts" && req.method === "GET") {
      return json({
        environment: { id: ENVIRONMENT_ID, name: ENVIRONMENT_NAME },
        home: HOME,
        destinations: threadStartProfiles(),
      });
    }
    if (url.pathname === "/v1/governor-controls" && req.method === "GET") {
      try { return json({ governors: governorControls() }); }
      catch (cause: any) { return error(cause?.message ?? "Could not read governor controls", 503); }
    }
    // The drawer footer shows this host's load beside its controls. The long
    // poll carries it only while the drawer is open, so a direct read lets the
    // footer fill in the moment the drawer opens rather than after a poll.
    if (url.pathname === "/v1/machine" && req.method === "GET") {
      try { return json({ machine: readMachineUsage() }); }
      catch (cause: any) { return error(cause?.message ?? "Could not read machine usage", 503); }
    }
    const governorToggle = url.pathname.match(/^\/v1\/governor-controls\/(openai|anthropic)\/toggle$/);
    if (governorToggle && req.method === "POST") {
      try { return json({ governors: toggleGovernor(governorToggle[1] as GovernorProvider) }); }
      catch (cause: any) { return error(cause?.message ?? "Could not toggle governor control", 503); }
    }
    if (url.pathname === "/v1/audio/thunder" && req.method === "GET") {
      try {
        return json({ thunder: thunderToggleOperation ? await thunderToggleOperation : await thunderStatus() });
      } catch (cause: any) { return error(cause?.message ?? "Could not read thunder status", 503); }
    }
    if (url.pathname === "/v1/audio/thunder/toggle" && req.method === "POST") {
      try {
        return json({ thunder: await toggleThunder() });
      } catch (cause: any) { return error(cause?.message ?? "Could not toggle thunder", 503); }
    }
    if (url.pathname === "/v1/uploads/init" && req.method === "POST") {
      try {
        const body = await readBody(req);
        const requestId = String(body.requestId ?? "");
        const uploadSessionId = String(body.sessionId ?? "");
        const name = uploadName(String(body.name ?? ""));
        const size = Number(body.size);
        if (!/^[0-9a-f-]{36}$/i.test(requestId)) return error("Valid requestId required");
        if (!sessionRow.get(uploadSessionId)) return error("Session not found", 404);
        if (!Number.isSafeInteger(size) || size < 0) return error("Valid upload size required");
        const old = db.query("SELECT * FROM upload_transfers WHERE request_id=?").get(requestId) as any;
        if (old) return json({ upload: { id: old.id, offset: Number(old.received_size), size: Number(old.expected_size) } });
        const id = crypto.randomUUID();
        const root = join(DATA, "upload-parts");
        mkdirSync(root, { recursive: true, mode: 0o700 });
        const path = join(root, id);
        writeFileSync(path, "", { mode: 0o600 });
        db.query(`INSERT INTO upload_transfers(id,request_id,session_id,name,content_type,expected_size,received_size,temp_path,created_at)
          VALUES(?,?,?,?,?,?,0,?,?)`).run(id, requestId, uploadSessionId, name,
            String(body.contentType ?? "application/octet-stream"), size, path, now());
        return json({ upload: { id, offset: 0, size } }, 201);
      } catch (cause: any) { return error(cause?.message ?? "Could not initialize upload", 400); }
    }
    const uploadChunk = url.pathname.match(/^\/v1\/uploads\/([0-9a-f-]+)$/i);
    if (uploadChunk && req.method === "PUT") {
      try {
        const transfer = db.query("SELECT * FROM upload_transfers WHERE id=?").get(uploadChunk[1]) as any;
        if (!transfer) return error("Upload not found", 404);
        const offset = Number(url.searchParams.get("offset"));
        if (!Number.isSafeInteger(offset) || offset !== Number(transfer.received_size))
          return json({ error: "Upload offset does not match", offset: Number(transfer.received_size) }, 409);
        const chunks: Uint8Array[] = [];
        let length = 0;
        const reader = req.body?.getReader();
        if (reader) while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          chunks.push(value); length += value.byteLength;
          if (length > 1024 * 1024) return error("Upload chunk exceeds 1 MiB", 413);
        }
        if (offset + length > Number(transfer.expected_size)) return error("Upload exceeds declared size", 413);
        const data = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), length);
        const expectedHash = req.headers.get("x-chunk-sha256") ?? "";
        if (!/^[0-9a-f]{64}$/i.test(expectedHash) || sha256(data) !== expectedHash.toLowerCase()) return error("Upload chunk hash does not match", 422);
        const handle = openSync(String(transfer.temp_path), "r+");
        try { writeSync(handle, data, 0, data.length, offset); } finally { closeSync(handle); }
        const next = offset + length;
        db.query("UPDATE upload_transfers SET received_size=? WHERE id=? AND received_size=?").run(next, transfer.id, offset);
        return json({ upload: { id: transfer.id, offset: next, size: Number(transfer.expected_size) } });
      } catch (cause: any) { return error(cause?.message ?? "Could not store upload chunk", 400); }
    }
    const uploadComplete = url.pathname.match(/^\/v1\/uploads\/([0-9a-f-]+)\/complete$/i);
    if (uploadComplete && req.method === "POST") {
      try {
        const transfer = db.query("SELECT * FROM upload_transfers WHERE id=?").get(uploadComplete[1]) as any;
        if (!transfer) return error("Upload not found", 404);
        if (Number(transfer.received_size) !== Number(transfer.expected_size))
          return json({ error: "Upload is incomplete", offset: Number(transfer.received_size) }, 409);
        const body = await readBody(req);
        const data = await Bun.file(String(transfer.temp_path)).arrayBuffer();
        const fileHash = sha256(new Uint8Array(data));
        if (String(body.sha256 ?? "").toLowerCase() !== fileHash) return error("Completed upload hash does not match", 422);
        const uploadSession = sessionRow.get(String(transfer.session_id)) as any;
        if (!uploadSession) return error("Session not found", 404);
        const uploadTarget = REMOTE_TARGETS.get(String(uploadSession.execution_target)) ?? null;
        let file: any;
        if (uploadTarget) {
          const transferRequest = new Request("http://localhost/upload", { method: "POST", body: Bun.file(String(transfer.temp_path)).stream(), duplex: "half" } as RequestInit);
          file = await storeWorkUpload(transferRequest, String(transfer.name), uploadTarget);
          unlinkSync(String(transfer.temp_path));
        } else {
          mkdirSync(INGESTION, { recursive: true, mode: 0o700 });
          const destination = availableUploadPath(INGESTION, String(transfer.name));
          renameSync(String(transfer.temp_path), destination);
          file = { name: basename(destination), path: destination, size: Number(transfer.expected_size) };
        }
        db.transaction(() => {
          db.query("INSERT OR REPLACE INTO uploads(path,session_id,environment,created_at) VALUES(?,?,?,?)")
            .run(file.path, transfer.session_id, uploadTarget?.id ?? "local", now());
          db.query("DELETE FROM upload_transfers WHERE id=?").run(transfer.id);
        })();
        return json({ file: { ...file, sha256: fileHash, environment: uploadTarget?.id ?? "local" } }, 201);
      } catch (cause: any) { return error(cause?.message ?? "Could not complete upload", 400); }
    }
    if (url.pathname === "/v1/uploads" && req.method === "POST") {
      try {
        const name = url.searchParams.get("name") ?? "";
        const uploadSessionId = url.searchParams.get("sessionId") ?? "";
        const uploadSession = uploadSessionId ? sessionRow.get(uploadSessionId) as any : null;
        if (uploadSessionId && !uploadSession) return error("Session not found", 404);
        const uploadTarget = uploadSession ? REMOTE_TARGETS.get(String(uploadSession.execution_target)) ?? null : null;
        const file = uploadTarget ? await storeWorkUpload(req, name, uploadTarget) : await storeUpload(req, name, INGESTION);
        if (uploadSession) db.query("INSERT OR REPLACE INTO uploads(path,session_id,environment,created_at) VALUES(?,?,?,?)")
          .run(file.path, uploadSessionId, uploadTarget?.id ?? "local", now());
        return json({ file: { ...file, environment: uploadTarget?.id ?? "local" } }, 201);
      } catch (cause: any) { return error(cause?.message ?? "Upload failed", 400); }
    }
    if (url.pathname === "/v1/uploads" && req.method === "DELETE") {
      try {
        const requested = url.searchParams.get("name") ?? "";
        const name = uploadName(requested);
        if (name !== requested) return error("Invalid uploaded file name");
        const uploadSessionId = url.searchParams.get("sessionId") ?? "";
        const uploadSession = uploadSessionId ? sessionRow.get(uploadSessionId) as any : null;
        const deleteTarget = uploadSession
          ? REMOTE_TARGETS.get(String(uploadSession.execution_target)) ?? null
          : REMOTE_TARGETS.get(url.searchParams.get("environment") ?? "") ?? null;
        const tracked = uploadSessionId
          ? db.query("SELECT path FROM uploads WHERE session_id=? AND path LIKE ?").get(uploadSessionId, `%/${name}`) as any
          : null;
        if (deleteTarget) await deleteWorkUpload(name, deleteTarget);
        else {
          const path = tracked?.path ?? join(INGESTION, name);
          if (existsSync(path)) unlinkSync(path);
        }
        if (tracked?.path) db.query("DELETE FROM uploads WHERE path=? AND session_id=?").run(tracked.path, uploadSessionId);
        return json({ ok: true });
      } catch (cause: any) { return error(cause?.message ?? "Could not remove upload", 400); }
    }
    // Read-only observation of every host's autonomous agents. There is no
    // prompt, steer, or abort surface here: the orchestrator owns their work.
    if (url.pathname === "/v1/agents/runs" && req.method === "GET") {
      try {
        const snapshots = await Promise.all(agentHosts.map((host) => host.runs()));
        return json({
          runs: snapshots.flatMap((snapshot) => snapshot.runs),
          running: snapshots.reduce((total, snapshot) => total + snapshot.running, 0),
          hosts: agentHosts.map((host, index) => ({
            key: host.ref.key,
            label: host.ref.label,
            name: host.ref.name,
            running: snapshots[index]!.running,
            updatedAt: snapshots[index]!.updatedAt,
            error: snapshots[index]!.error,
          })),
        });
      }
      catch (cause: any) { return error(cause?.message ?? "Could not read agent runs", 503); }
    }
    const agentEvents = url.pathname.match(/^\/v1\/agents\/runs\/([^/]+)\/events$/);
    if (agentEvents && req.method === "GET") {
      const addressed = parseRunKey(decodeURIComponent(agentEvents[1]));
      const host = addressed ? agentHostsByKey.get(addressed.host) : undefined;
      if (!addressed || !host) return error("Invalid agent run", 400);
      try {
        const after = Math.max(0, Number(url.searchParams.get("after") ?? 0) || 0);
        const stream = await host.events(addressed.runId, after);
        if (!stream.run) return error("Agent run not found", 404);
        return json({
          run: stream.run,
          events: stream.events,
          liveText: stream.liveText,
          liveThinking: stream.liveThinking,
        });
      } catch (cause: any) { return error(cause?.message ?? "Could not read the agent transcript", 503); }
    }
    if (url.pathname === "/v1/workspaces" && req.method === "GET") {
      return json({ workspaces: [...workspaces.values()].map(({ id, name, path }) => ({ id, name, path })) });
    }
    if (url.pathname === "/v1/sync" && req.method === "POST") {
      try {
        const body = await readBody(req);
        const after = Math.max(0, Number(body.after ?? 0) || 0);
        await awaitSync(after, Number(body.waitMs ?? 25_000));
        const sequence = syncSequence;
        const rows = db.query("SELECT * FROM sessions WHERE archived_at IS NULL ORDER BY created_at DESC").all() as any[];
        const includeArchived = body.includeArchived === true;
        const selectedId = typeof body.selectedId === "string" ? body.selectedId : "";
        let contextUpdate: any = null;
        let selectedSession: any = null;
        if (selectedId) {
          const selected = sessionRow.get(selectedId) as any;
          if (selected) {
            selectedSession = publicSession(selected);
            const stored = storedContext(selectedId);
            if (stored) {
              const projected = body.contextProjection === "display";
              const display = projected ? displayContext(selectedId, stored.hash, stored.document) : null;
              const document = display?.document ?? stored.document;
              const hash = display?.hash ?? stored.hash;
              const baseHash = typeof body.contextHash === "string" ? body.contextHash : "";
              if (baseHash !== hash) {
                const candidate = contextVersions.get(selectedId)?.get(baseHash);
                // A cache written before display projection contains provider
                // signatures throughout the document. Send one compact full
                // projection instead of representing those scattered removals
                // as a nearly full-size splice.
                const base = projected && candidate?.includes('"thinkingSignature"') ? undefined : candidate;
                contextUpdate = base === undefined
                  ? { kind: "full", capturedAt: stored.capturedAt, hash, document }
                  : { kind: "splice", capturedAt: stored.capturedAt, hash, splice: contextSplice(base, document) };
              }
            } else if (body.contextHash) contextUpdate = { kind: "clear", capturedAt: 0, hash: "" };
          }
        }
        let sessionEvents: any = null;
        if (typeof body.eventSessionId === "string" && body.eventSessionId) {
          const eventSessionId = String(body.eventSessionId);
          const eventRow = sessionRow.get(eventSessionId) as any;
          if (eventRow) {
            const eventAfter = Math.max(0, Number(body.eventAfter ?? 0) || 0);
            const events = db.query("SELECT seq,time,type,payload FROM events WHERE session_id=? AND seq>? ORDER BY seq LIMIT 150")
              .all(eventSessionId, eventAfter).map((entry: any) => ({ seq: entry.seq, time: entry.time, type: entry.type, ...JSON.parse(entry.payload) }));
            const runtime = runtimes.get(eventSessionId);
            sessionEvents = {
              events,
              liveTextUpdate: textUpdate(`session:${eventSessionId}:text`, body.eventLiveTextHash, runtime?.liveText ?? ""),
              liveThinkingUpdate: textUpdate(`session:${eventSessionId}:thinking`, body.eventLiveThinkingHash, runtime?.liveThinking ?? ""),
              session: publicSession(eventRow),
            };
          }
        }
        let runList: any = null;
        if (body.includeAgentList === true) {
          const snapshots = await Promise.all(agentHosts.map((host) => host.runs()));
          runList = {
            runs: snapshots.flatMap((snapshot) => snapshot.runs),
            running: snapshots.reduce((total, snapshot) => total + snapshot.running, 0),
            hosts: agentHosts.map((host, index) => ({
              key: host.key,
              label: host.ref.label,
              name: host.ref.name,
              running: snapshots[index]!.running,
              updatedAt: snapshots[index]!.updatedAt,
              error: snapshots[index]!.error,
            })),
          };
        }
        let runEvents: any = null;
        if (typeof body.agentRunId === "string" && body.agentRunId) {
          const addressed = parseRunKey(body.agentRunId);
          const host = addressed ? agentHostsByKey.get(addressed.host) : undefined;
          if (addressed && host) {
            const stream = await host.events(addressed.runId, Math.max(0, Number(body.agentAfter ?? 0) || 0));
            if (stream.run) runEvents = {
              run: stream.run,
              events: stream.events,
              liveTextUpdate: textUpdate(`agent:${body.agentRunId}:text`, body.agentLiveTextHash, stream.liveText),
              liveThinkingUpdate: textUpdate(`agent:${body.agentRunId}:thinking`, body.agentLiveThinkingHash, stream.liveThinking),
            };
          }
        }
        const watched = Array.isArray(body.watchedIds)
          ? body.watchedIds.slice(0, 100).map((id: unknown) => sessionRow.get(String(id)) as any).filter(Boolean).map((watchedRow: any) => {
              const session = publicSession(watchedRow) as any;
              if (!["RUNNING", "STARTING", "ABORTING"].includes(String(watchedRow.state))) {
                const event = db.query("SELECT payload FROM events WHERE session_id=? AND type='assistant' ORDER BY seq DESC LIMIT 1").get(watchedRow.id) as any;
                if (event?.payload) {
                  try { session.lastAssistantText = String(JSON.parse(event.payload).text ?? "").slice(0, 4_000); } catch {}
                }
              }
              return session;
            })
          : [];
        refreshPlanUsageIfDue();
        return compressedJson(req, {
          epoch: SUPERVISOR_EPOCH,
          seq: sequence,
          sessions: body.includeSessions === false ? null : publicSessions(rows),
          archivedSessions: includeArchived ? publicSessions(archivedPage(0, ARCHIVED_PAGE_SIZE)) : null,
          archivedTotal: archivedCount(),
          selectedSession,
          contextUpdate,
          watched,
          sessionEvents,
          agentRuns: runList,
          agentEvents: runEvents,
          agents: body.includeDashboard === false ? null : await activeAgents(),
          plans: body.includeDashboard === false ? null : { cards: manifestPlanCards(PROVIDER_MANIFEST, planUsage), updatedAt: planUsage.updatedAt },
          governors: body.includeDashboard === false ? null : governorControls(),
          machine: body.includeDashboard === false ? null : readMachineUsage(),
        });
      } catch (cause: any) { return error(cause?.message ?? "Could not synchronize", 400); }
    }
    if (url.pathname === "/v1/sessions" && req.method === "GET") {
      refreshPlanUsageIfDue();
      const rows = db.query("SELECT * FROM sessions WHERE archived_at IS NULL ORDER BY created_at DESC").all();
      const archivedRows = archivedPage(0, ARCHIVED_PAGE_SIZE);
      return json({
        sessions: publicSessions(rows),
        archivedSessions: publicSessions(archivedRows),
        archivedTotal: archivedCount(),
        agents: await activeAgents(),
        plans: { cards: manifestPlanCards(PROVIDER_MANIFEST, planUsage), updatedAt: planUsage.updatedAt },
        governors: governorControls(),
        machine: readMachineUsage(),
      });
    }
    if (url.pathname === "/v1/sessions/archived" && req.method === "GET") {
      const offset = Math.max(0, Math.floor(Number(url.searchParams.get("offset") ?? 0) || 0));
      const requested = Math.floor(Number(url.searchParams.get("limit") ?? ARCHIVED_PAGE_SIZE) || ARCHIVED_PAGE_SIZE);
      const limit = Math.min(ARCHIVED_MAX_PAGE_SIZE, Math.max(1, requested));
      const total = archivedCount();
      const sessions = publicSessions(archivedPage(offset, limit));
      return json({ sessions, total, offset, limit, hasMore: offset + sessions.length < total });
    }
    if (url.pathname === "/v1/sessions" && req.method === "POST") {
      try {
        const body = await readBody(req);
        const requestId = String(body.requestId ?? "");
        const old = requestResult(requestId);
        if (old) return json(JSON.parse(old.response), old.status);
        if (!/^[0-9a-f-]{36}$/i.test(requestId)) return error("Valid requestId required");
        const destination = THREAD_DESTINATIONS.get(String(body.destination ?? "home"));
        if (!destination) return error("Unknown thread destination");
        const modelId = String(body.model ?? destination.defaultModel);
        // A destination only starts the models it actually offers, so an out-of-date client
        // cannot place an Anthropic thread on a machine that has no Anthropic access.
        if (modelId !== destination.defaultModel && !destination.models.includes(modelId))
          return error("Model not available at this destination");
        const model = THREAD_MODELS.get(modelId);
        if (!model) return error("Unknown thread model");
        const preset = {
          provider: model.provider,
          modelId: model.modelId,
          thinkingLevel: destination.thinkingLevel,
          executionTarget: destination.executionTarget,
        };
        const workspaceId = destination.workspaceId;
        const name = nextThreadName();
        const id = crypto.randomUUID();
        const time = now();
        db.query(`
          INSERT INTO sessions(
            id,name,workspace_id,session_path,state,created_at,updated_at,last_error,
            initial_provider,current_provider,initial_model,initial_thinking,execution_target,remote_cwd
          ) VALUES(?,?,?,?,?,?,?,NULL,?,?,?,?,?,?)
        `).run(id, name, workspaceId, null, "STOPPED", time, time, preset.provider, preset.provider, preset.modelId, preset.thinkingLevel,
          preset.executionTarget, REMOTE_TARGETS.get(preset.executionTarget)?.cwd ?? null);
        const response = { session: publicSession(sessionRow.get(id)) };
        saveRequest(requestId, id, "create", 201, response);
        activate(sessionRow.get(id)).catch((e) => {
          const latest = sessionRow.get(id) as any;
          if (latest && !["STOPPED", "IDLE"].includes(String(latest.state))) setState(id, "FAILED", String(e.message ?? e));
        });
        return json(response, 201);
      } catch (e: any) { return error(e.message ?? "Invalid request"); }
    }
    const queuedItemMatch = url.pathname.match(/^\/v1\/sessions\/([0-9a-f-]+)\/queue\/([0-9a-f-]+)$/i);
    if (queuedItemMatch && req.method === "DELETE") {
      const [_, sessionId, workId] = queuedItemMatch;
      const row = sessionRow.get(sessionId) as any;
      if (!row) return error("Session not found", 404);
      let found = false;
      let cancelled: { text: string } | null = null;
      db.transaction(() => {
        const work = db.query("SELECT text,state,inserted_at FROM work_items WHERE id=? AND session_id=?").get(workId, sessionId) as any;
        if (!work) return;
        found = true;
        if (work.state !== "queued" || work.inserted_at) return;
        const changedAt = now();
        const result = db.query(`
          UPDATE work_items SET state='cancelled',updated_at=?,last_error='Queued message cancelled by user'
          WHERE id=? AND session_id=? AND state='queued' AND inserted_at IS NULL
        `).run(changedAt, workId, sessionId);
        if (result.changes !== 1) return;
        db.query("UPDATE sessions SET revision=revision+1,updated_at=? WHERE id=?").run(changedAt, sessionId);
        cancelled = { text: String(work.text) };
      })();
      if (!found) return error("Queued message not found", 404);
      if (!cancelled) return error("Message has already started", 409);
      return json({ ok: true, workId, text: cancelled.text, session: publicSession(sessionRow.get(sessionId)) });
    }
    const queueMatch = url.pathname.match(/^\/v1\/sessions\/([0-9a-f-]+)\/queue\/([0-9a-f-]+)\/steer$/i);
    if (queueMatch && req.method === "POST") {
      const [_, sessionId, workId] = queueMatch;
      const row = sessionRow.get(sessionId) as any;
      if (!row) return error("Session not found", 404);
      const work = db.query("SELECT rowid queue_order,* FROM work_items WHERE id=? AND session_id=?").get(workId, sessionId) as any;
      if (!work) return error("Queued message not found", 404);
      if (work.state !== "queued" || work.delivery !== "followUp") return error("Message has already started", 409);
      const earlierWork = Number((db.query(`
        SELECT COUNT(*) count FROM work_items
        WHERE session_id=? AND rowid<? AND state IN ('queued','running','dispatched')
      `).get(sessionId, work.queue_order) as any)?.count ?? 0);
      const rt = runtimes.get(sessionId);
      const canSteer = earlierWork > 0 || !!rt && ["STARTING", "DISPATCHING", "RUNNING"].includes(rt.phase);
      if (!canSteer) return error("The agent has already finished; this message will start normally", 409);
      db.query("UPDATE work_items SET delivery='steer',updated_at=? WHERE id=? AND state='queued'").run(now(), workId);
      if (work.inserted_at && Number(work.event_seq) > 0) {
        const event = db.query("SELECT payload FROM events WHERE seq=? AND session_id=? AND type='user'").get(work.event_seq, sessionId) as any;
        if (event?.payload) {
          const payload = JSON.parse(event.payload);
          payload.delivery = "steer";
          db.query("UPDATE events SET payload=? WHERE seq=?").run(JSON.stringify(payload), work.event_seq);
          emit(sessionId, "user_delivery", { eventSeq: Number(work.event_seq), workId, delivery: "steer" });
        }
      }
      touchSession(sessionId);
      kickSession(sessionId);
      return json({ ok: true, workId, delivery: "steer", session: publicSession(sessionRow.get(sessionId)) });
    }
    const match = url.pathname.match(/^\/v1\/sessions\/([0-9a-f-]+)(?:\/(prompt|abort|events|context|settings|name|commands|command|unarchive))?$/i);
    if (!match) return error("Not found", 404);
    const id = match[1];
    const action = match[2];
    const row = sessionRow.get(id) as any;
    if (!row) return error("Session not found", 404);
    if (!action && req.method === "GET") return json({ session: publicSession(row) });
    if (action === "unarchive" && req.method === "POST") {
      if (!row.archived_at) return json({ ok: true, session: publicSession(row) });
      const changedAt = now();
      db.query("UPDATE sessions SET archived_at=NULL,state='STOPPED',last_error=NULL,updated_at=?,revision=revision+1 WHERE id=?")
        .run(changedAt, id);
      return json({ ok: true, session: publicSession(sessionRow.get(id)) });
    }
    if (!action && req.method === "PUT") return error("Threads cannot be edited", 405);
    if (!action && req.method === "DELETE") {
      if (!row.archived_at) {
        const changedAt = now();
        db.transaction(() => {
          db.query("UPDATE work_items SET state='cancelled',updated_at=?,last_error='Thread archived by user' WHERE session_id=? AND state IN ('queued','running','dispatched')")
            .run(changedAt, id);
          db.query("UPDATE sessions SET archived_at=?,state='STOPPED',last_error=NULL,updated_at=?,revision=revision+1 WHERE id=?")
            .run(changedAt, changedAt, id);
        })();
      }
      const timer = retryTimers.get(id); if (timer) clearTimeout(timer);
      retryTimers.delete(id);
      const rt = runtimes.get(id);
      if (rt) {
        rt.expectedExit = true;
        rt.suppressOutput = true;
        setRuntimePhase(id, rt, "STOPPING");
        try { if (runtimeWorking(rt)) sendLine(rt, { type: "abort" }); } catch {}
        await terminateRuntimeProcess(rt);
      }
      if (!ownsSupervisorLease()) return error("Supervisor instance was replaced", 503);
      return json({ ok: true, archived: true, session: publicSession(sessionRow.get(id)) });
    }
    if (row.archived_at && action !== "events" && !(action === "context" && req.method === "GET"))
      return error("Thread is archived; unarchive it before continuing", 409);
    if (action === "context" && req.method === "GET") {
      const stored = storedContext(id);
      const hash = stored?.hash ?? "empty";
      const etag = `\"${hash}\"`;
      if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag, "cache-control": "no-cache" } });
      const response = compressedJson(req, {
        capturedAt: stored?.capturedAt ?? 0,
        context: stored ? JSON.parse(stored.document) : null,
        hash: stored?.hash ?? "",
        session: publicSession(sessionRow.get(id)),
      });
      response.headers.set("etag", etag);
      return response;
    }
    if (action === "context" && req.method === "PATCH") {
      try {
        const body = await readBody(req);
        const capturedAt = Number(body.capturedAt);
        const splice = body.splice as ContextSplice;
        if (!Number.isSafeInteger(capturedAt) || capturedAt <= 0 || !splice) return error("Valid context patch required");
        const current = storedContext(id);
        if (!current) return error("Context base is missing", 409);
        if (capturedAt <= current.capturedAt) return json({ ok: true, capturedAt: current.capturedAt, hash: current.hash });
        const document = applyContextSplice(current.document, splice);
        db.query(`
          INSERT INTO session_context_patches(session_id,captured_at,base_hash,target_hash,prefix_bytes,delete_bytes,insert_base64)
          VALUES(?,?,?,?,?,?,?)
        `).run(id, capturedAt, splice.baseHash, splice.targetHash, splice.prefixBytes, splice.deleteBytes, splice.insertBase64);
        rememberContext(id, document);
        signalSync();
        return json({ ok: true, capturedAt, hash: splice.targetHash });
      } catch (cause: any) { return error(cause?.message ?? "Could not patch model context", 409); }
    }
    if (action === "context" && req.method === "PUT") {
      try {
        const body = await readBody(req);
        const capturedAt = Number(body.capturedAt);
        const context = body.context;
        if (!Number.isSafeInteger(capturedAt) || capturedAt <= 0) return error("Valid context capture time required");
        if (!context || typeof context !== "object" || typeof context.systemPrompt !== "string"
          || !Array.isArray(context.tools) || !Array.isArray(context.messages)) return error("Valid model context required");
        const document = JSON.stringify(context);
        let changed = false;
        let acknowledgedHash = sha256(document);
        db.transaction(() => {
          const current = storedContext(id);
          if (current && capturedAt <= current.capturedAt) { acknowledgedHash = current.hash; return; }
          db.query(`
            INSERT INTO session_contexts(session_id,captured_at,context) VALUES(?,?,?)
            ON CONFLICT(session_id) DO UPDATE SET captured_at=excluded.captured_at,context=excluded.context
          `).run(id, capturedAt, document);
          db.query("DELETE FROM session_context_patches WHERE session_id=?").run(id);
          changed = true;
        })();
        if (changed) {
          rememberContext(id, document);
          signalSync();
        }
        return json({ ok: true, capturedAt, hash: acknowledgedHash });
      } catch (cause: any) { return error(cause?.message ?? "Could not store model context", 400); }
    }
    if (action === "events" && req.method === "GET") {
      const after = Math.max(0, Number(url.searchParams.get("after") ?? 0) || 0);
      let floor = after;
      if (after === 0) {
        const oldestVisible = db.query(`
          SELECT seq FROM events
          WHERE session_id=? AND type IN ('user','assistant','tool_start','notice','thinking')
          ORDER BY seq DESC LIMIT 1 OFFSET 49
        `).get(id) as { seq?: number } | null;
        floor = oldestVisible?.seq ? oldestVisible.seq - 1 : 0;
      }
      const events = db.query("SELECT seq,time,type,payload FROM events WHERE session_id=? AND seq>? ORDER BY seq LIMIT 150").all(id, floor)
        .map((e: any) => ({ seq: e.seq, time: e.time, type: e.type, ...JSON.parse(e.payload) }));
      const rt = runtimes.get(id);
      return json({
        events,
        liveText: rt?.liveText ?? "",
        liveThinking: rt?.liveThinking ?? "",
        session: publicSession(sessionRow.get(id)),
      });
    }
    if (action === "name" && req.method === "PUT") {
      try {
        const name = normalizeThreadName(await req.text());
        if (!/^\d+$/.test(row.name)) {
          if (row.name === name) return json({ ok: true, name });
          return error("Thread has already been renamed", 409);
        }
        const rt = runtimes.get(id);
        if (!rt) return error("Agent is not active", 409);
        await rpc(rt, "set_session_name", { name }, 10_000);
        if (!ownsSupervisorLease()) return error("Supervisor instance was replaced", 503);
        db.query("UPDATE sessions SET name=?,updated_at=?,revision=revision+1 WHERE id=?").run(name, now(), id);
        return json({ ok: true, name });
      } catch (e: any) { return error(e.message ?? "Could not rename thread", 400); }
    }
    if (action === "commands" && req.method === "GET") {
      try { return json(await threadCommands(row)); }
      catch (e: any) { return error(e.message ?? "Could not load slash commands", 500); }
    }
    if (action === "command" && req.method === "POST") {
      try {
        const body = await readBody(req);
        const requestId = String(body.requestId ?? "");
        if (!/^[0-9a-f-]{36}$/i.test(requestId)) return error("Valid requestId required");
        const name = String(body.name ?? "");
        const args = String(body.args ?? "").trim();
        const result = await runCommand(row, requestId, name, args);
        return json(result.response, result.status);
      } catch (e: any) { return error(e.message ?? "Slash command failed", 400); }
    }
    if (action === "settings" && req.method === "GET") {
      try { return json({ settings: await threadSettings(row) }); }
      catch (e: any) { return error(e.message ?? "Could not load thread settings", 500); }
    }
    if (action === "settings" && req.method === "PUT") {
      try {
        const body = await readBody(req);
        const rt = await activate(row);
        const pendingWork = Number((db.query(
          "SELECT COUNT(*) AS count FROM work_items WHERE session_id=? AND state IN ('queued','running','dispatched')",
        ).get(id) as any)?.count ?? 0);
        if (rt.phase !== "IDLE" || pendingWork > 0) return error("Wait for the thread to become idle before changing settings", 409);
        if (body.modelProvider != null || body.modelId != null) {
          const provider = String(body.modelProvider ?? "");
          const modelId = String(body.modelId ?? "");
          if (!provider || !modelId) return error("modelProvider and modelId are required");
          await rpc(rt, "set_model", { provider, modelId }, 30000);
        }
        if (body.thinkingLevel != null) {
          await rpc(rt, "set_thinking_level", { level: String(body.thinkingLevel) }, 30000);
        }
        if (body.speedMode != null) {
          const speedMode = String(body.speedMode);
          if (speedMode !== "normal" && speedMode !== "priority") return error("speedMode must be normal or priority");
          const provider = String(body.modelProvider ?? (sessionRow.get(id) as any)?.current_provider ?? "");
          if (!provider.startsWith("openai")) return error("Priority speed is available only for OpenAI threads", 409);
          const tier = speedMode === "priority" ? "priority" : "default";
          writeServiceTier(id, tier);
          db.query("UPDATE sessions SET service_tier=?,updated_at=?,revision=revision+1 WHERE id=?").run(tier, now(), id);
        }
        return json({ settings: await threadSettings(sessionRow.get(id)) });
      } catch (e: any) { return error(e.message ?? "Could not update thread settings", 500); }
    }
    if (action === "prompt" && req.method === "POST") {
      try {
        const body = await readBody(req);
        const requestId = String(body.requestId ?? "");
        const old = requestResult(requestId);
        if (old) return json(JSON.parse(old.response), old.status);
        if (!/^[0-9a-f-]{36}$/i.test(requestId)) return error("Valid requestId required");
        const text = String(body.text ?? "").trim();
        if (!text) return error("Prompt is empty");
        const rt = runtimes.get(id);
        if (rt && ["ABORTING", "STOPPING"].includes(rt.phase)) return error("Thread is stopping; wait for it to become resumable", 409);
        const delivery = body.delivery === "steer" ? "steer" : body.delivery == null || body.delivery === "followUp" ? "followUp" : null;
        if (!delivery) return error("delivery must be steer or followUp");
        return json(enqueuePrompt(id, requestId, text, delivery), 202);
      } catch (e: any) { return error(e.message ?? "Prompt failed", 400); }
    }
    if (action === "abort" && req.method === "POST") {
      const activeItems = db.query(`
        SELECT rowid queue_order,id,state,inserted_at FROM work_items
        WHERE session_id=? AND state IN ('queued','running','dispatched')
        ORDER BY created_at,rowid
      `).all(id) as any[];
      const rt = runtimes.get(id);
      const activeRuntime = !!rt && ["DISPATCHING", "RUNNING", "ABORTING"].includes(rt.phase);
      const currentWork = activeItems.find((item) => item.state === "running" || item.state === "dispatched")
        ?? (!activeRuntime ? activeItems[0] : undefined);
      const retainedCount = activeItems.filter((item) => item.id !== currentWork?.id).length;
      if (rt?.phase === "ABORTING") return json({ ok: true, aborting: true, session: publicSession(sessionRow.get(id)) });
      if (rt?.phase === "STOPPING") return error("Agent is pausing after inactivity", 409);

      // A claimed message can be cancelled while the runtime is still starting;
      // the activation and worker both re-check its durable state before dispatch.
      if (!rt || rt.phase === "STARTING" || rt.phase === "IDLE") {
        if (currentWork) {
          db.query("UPDATE work_items SET state='cancelled',updated_at=?,last_error='Current turn stopped by user' WHERE id=?")
            .run(now(), currentWork.id);
        }
        const retryTimer = retryTimers.get(id);
        if (retryTimer) clearTimeout(retryTimer);
        retryTimers.delete(id);
        if (!rt) {
          setState(id, retainedCount > 0 ? "RUNNING" : "STOPPED");
          if (retainedCount > 0) kickSession(id);
        } else if (rt.phase === "IDLE") {
          rt.retrying = false;
          setRuntimePhase(id, rt, "IDLE", retainedCount > 0 ? "RUNNING" : "IDLE");
          if (retainedCount > 0) kickSession(id);
        } else {
          touchSession(id);
        }
        return json({ ok: true, retainedQueued: retainedCount, session: publicSession(sessionRow.get(id)) });
      }

      // Abort only the active operation. The Pi RPC child remains alive and owns
      // any steering already accepted into its queue; supervisor-held follow-ups
      // remain in SQLite. Process termination is reserved for the idle reaper.
      setRuntimePhase(id, rt, "ABORTING", "ABORTING");
      let abortFailure: unknown = null;
      try { await rpc(rt, "abort", {}, 10_000); }
      catch (cause) { abortFailure = cause; }
      if (abortFailure) {
        try {
          const state = await rpc(rt, "get_state", {}, 2_000);
          const active = Boolean(state.isStreaming || state.isCompacting || Number(state.pendingMessageCount ?? 0) > 0);
          if (active) {
            setRuntimePhase(id, rt, "RUNNING", "RUNNING", `Could not stop current operation: ${String((abortFailure as any)?.message ?? abortFailure)}`);
            return error("Could not stop the current operation; the agent is still running", 409);
          }
        } catch {
          setRuntimePhase(id, rt, "RUNNING", "RUNNING", `Could not confirm stop: ${String((abortFailure as any)?.message ?? abortFailure)}`);
          return error("Could not confirm that the current operation stopped; the agent process was left running", 409);
        }
      }

      const changedAt = now();
      if (currentWork) {
        db.query("UPDATE work_items SET state='cancelled',updated_at=?,last_error='Current turn stopped by user' WHERE id=?")
          .run(changedAt, currentWork.id);
        rt.dispatchedWorkIds.delete(String(currentWork.id));
      }
      // session.abort() waits until Pi is idle, including steering that Pi already
      // accepted. Those inserted messages therefore completed in this same child.
      for (const workId of rt.dispatchedWorkIds) {
        db.query("UPDATE work_items SET state='complete',updated_at=?,last_error=NULL WHERE id=? AND state='dispatched'")
          .run(changedAt, workId);
      }
      rt.dispatchedWorkIds.clear();
      rt.compacting = false;
      rt.retrying = false;
      rt.activeTools.clear();
      rt.steeringQueued = 0;
      rt.followUpQueued = 0;
      rt.liveText = "";
      rt.liveThinking = "";
      rt.lastActivity = Date.now();
      const supervisorQueued = Number((db.query(
        "SELECT COUNT(*) count FROM work_items WHERE session_id=? AND state IN ('queued','running')",
      ).get(id) as any)?.count ?? 0);
      setRuntimePhase(id, rt, "IDLE", supervisorQueued > 0 ? "RUNNING" : "IDLE");
      if (supervisorQueued > 0) kickSession(id);
      return json({ ok: true, retainedQueued: retainedCount, session: publicSession(sessionRow.get(id)) });
    }
    return error("Not found", 404);
  },
});
console.log(`Pi Remote listening on http://${server.hostname}:${server.port}`);

// A rejected promise anywhere (e.g. an un-awaited rpc get_state timing out
// under machine load) must never kill the supervisor: systemd restarts it,
// which respawns runtimes while the previous RPC children survive as orphans
// still executing their turn — producing two agents bound to one thread and
// duplicated work (observed 2026-08-10: 59 crash-loop restarts, thread 6).
process.on("unhandledRejection", (cause) => {
  console.error("Unhandled rejection (contained)", cause);
});
process.on("uncaughtException", (cause) => {
  console.error("Uncaught exception (contained)", cause);
});

// Reap orphan RPC children from a previous supervisor incarnation before any
// dispatch: at this point this process has spawned no children yet, so every
// live pi RPC process pointing at our session directory is a stale orphan
// double-executing or holding a session file we are about to reuse.
try {
  const sessionRoots = [join(DATA, "sessions")];
  const orphans = [...new Set(sessionRoots.flatMap((root) => {
    const pattern = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const survey = Bun.spawnSync(["pgrep", "-f", pattern]);
    return new TextDecoder().decode(survey.stdout).split("\n")
      .map((value) => Number(value.trim())).filter((pid) => Number.isFinite(pid) && pid > 1 && pid !== process.pid);
  }))];
  for (const pid of orphans) {
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
  const alive = (pid: number) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };
  const deadline = Date.now() + 2_000;
  while (orphans.some(alive) && Date.now() < deadline) Bun.sleepSync(50);
  const stubborn = orphans.filter(alive);
  for (const pid of stubborn) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  if (stubborn.length) Bun.sleepSync(100);
  if (orphans.length) console.error(
    `Reaped ${orphans.length} orphan RPC child(ren) from previous incarnation${stubborn.length ? ` (${stubborn.length} required SIGKILL)` : ""}`,
  );
} catch (cause) {
  console.error("Orphan reap failed", cause);
}

refreshPlanUsageIfDue();
for (const host of agentHosts) void host.refresh();
for (const row of db.query("SELECT DISTINCT session_id FROM work_items WHERE state='queued'").all() as any[]) kickSession(row.session_id);

// Sessions are on-demand rather than a permanent process fleet. Preserve the
// Pi JSONL session, but reap an idle RPC child after fifteen minutes.
// Periodically reconcile the in-memory projection with Pi's own state. This
// repairs dropped settled/compaction events and prevents stale mobile controls.
const stateReconciler = setInterval(() => {
  for (const [id, rt] of runtimes) {
    if (["ABORTING", "STOPPING"].includes(rt.phase) || rt.reconciling) continue;
    void reconcileRuntimeState(id, rt).catch((cause) => console.error(`State reconciliation failed for ${id}`, cause));
  }
}, STATE_RECONCILE_MS);

// Agent counts stay warm even when nobody has the drawer open, so a host that
// went unreachable is already reported the moment somebody looks.
const workAgentRefresher = setInterval(() => {
  for (const host of agentHosts) void host.refresh();
}, WORK_AGENT_REFRESH_MS);

// The nightly backup runs as root, outside this supervisor's mount namespace,
// so it cannot reach the ledger to take a consistent copy the way it used to.
// This is where that copy has to come from: SQLite writes it under its own
// locking, it lands inside the encrypted tree, and the backup then picks it up
// as ciphertext with everything else.
function writeLedgerSnapshot() {
  const directory = join(DATA, "backup");
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const target = join(directory, "supervisor.sqlite3");
    const staging = `${target}.writing`;
    if (existsSync(staging)) unlinkSync(staging);
    db.query(`VACUUM INTO '${staging.replaceAll("'", "''")}'`).run();
    renameSync(staging, target);
  } catch (cause: any) {
    console.error(`[supervisor] ledger snapshot failed: ${cause?.message ?? cause}`);
  }
}
writeLedgerSnapshot();
const ledgerSnapshotter = setInterval(writeLedgerSnapshot, 6 * 60 * 60_000);

function pruneUploadTransfers() {
  const cutoff = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  for (const transfer of db.query("SELECT id,temp_path FROM upload_transfers WHERE created_at<?").all(cutoff) as any[]) {
    try { if (existsSync(String(transfer.temp_path))) unlinkSync(String(transfer.temp_path)); } catch {}
    db.query("DELETE FROM upload_transfers WHERE id=?").run(transfer.id);
  }
}
pruneUploadTransfers();

const reaper = setInterval(() => {
  const cutoff = Date.now() - 15 * 60_000;
  pruneUploadTransfers();
  for (const [id, rt] of runtimes) {
    if (rt.phase === "IDLE" && rt.lastActivity < cutoff) {
      rt.expectedExit = true;
      rt.suppressOutput = true;
      setRuntimePhase(id, rt, "STOPPING");
      emit(id, "notice", { text: "Agent paused after inactivity" });
      void terminateRuntimeProcess(rt);
    }
  }
}, 60_000);

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(reaper);
  clearInterval(stateReconciler);
  clearInterval(workAgentRefresher);
  clearInterval(ledgerSnapshotter);
  for (const timer of retryTimers.values()) clearTimeout(timer);
  retryTimers.clear();
  if (ownsSupervisorLease()) {
    db.query("UPDATE work_items SET state='queued',resume=CASE WHEN state='dispatched' THEN 1 ELSE resume END,available_at=?,updated_at=?,last_error='Supervisor restarted before settling' WHERE state IN ('running','dispatched')")
      .run(Date.now(), now());
  }
  const exits: Promise<unknown>[] = [];
  for (const [id, rt] of runtimes) {
    const wasWorking = runtimeWorking(rt);
    rt.expectedExit = true;
    rt.suppressOutput = true;
    try { if (wasWorking) sendLine(rt, { type: "abort" }); } catch {}
    setRuntimePhase(id, rt, "STOPPING");
    exits.push(terminateRuntimeProcess(rt));
  }
  await Promise.race([Promise.all(exits), Bun.sleep(3_000)]);
  server.stop();
  for (const host of agentHosts) host.close();
  orchestratorDb.close();
  db.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGHUP", shutdown);
