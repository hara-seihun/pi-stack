import { Database } from "bun:sqlite";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { parseRunKey } from "./agent-runs";
import { AgentHost } from "./agent-hosts";
import { ORCHESTRATOR_CATALOG, OrchestratorClient, catalogAgentType, type PlanUsageSnapshot } from "pi-orchestrator/api";
import { planCards } from "./catalog-presentation";
import { readMachineUsage } from "./machine-usage";
import { displayContextDocument, type ContextImage } from "./context-display";
import { contextSplice, DocumentHistory, messageFinalizationKey, sha256, type ContextSplice } from "./sync";
import { appendContextPatch, readContext } from "./context-journal";
import { beginSupervisorGeneration, ensureSupervisorSchema } from "./database";
import { startLedgerSnapshots } from "./ledger-snapshot";
import { DEFAULT_LIVE_MODEL, DEFAULT_LIVE_VOICE, VoiceBroker } from "./voice/broker";
import { attachRuntimeHost, startRuntimeHost, type RuntimeTransport } from "./runtime-transport";
import { API } from "./api";
import { idleNotifications } from "./notifications";
import { listPersons, publicPerson } from "./persons";
import { knownEnvironments } from "./environments";
import { API_CORS_HEADERS } from "./cors";
import { fileBrowserError, listDirectory, localFileResponse, registerIconAssets, webResponse } from "./files";
import { governorControls, isGovernorProvider, toggleGovernor } from "./governors";
import { BASH_TIMEOUT_OPTIONS, DEFAULT_BASH_TIMEOUT_SECONDS, type AgentModelCount, type BashTimeoutSeconds, type Dashboard, type DocumentUpdate, type QueuedMessage, type Session, type SupervisorState, type SyncRequest, type SyncResponse } from "./protocol";
import { MachineActions } from "./machine-actions";
import { availableUploadPath, storeUpload, uploadName } from "./uploads";
import {
  generatedThreadName,
  shouldNameThread,
  THREAD_NAMING_HISTORY,
  THREAD_NAMING_INSTRUCTION,
  threadNamingModel,
} from "./thread-naming";

const VERSION = (JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8")) as { version: string }).version;
const ENVIRONMENT_ID = process.env.PI_REMOTE_ENVIRONMENT_ID ?? "local";
const ENVIRONMENT_NAME = process.env.PI_REMOTE_ENVIRONMENT_NAME ?? "Local";
const ENVIRONMENT_REQUIRES_UNLOCK = process.env.PI_REMOTE_REQUIRES_UNLOCK === "true";
if (!/^[a-z][a-z0-9-]{0,31}$/.test(ENVIRONMENT_ID)) throw new Error("PI_REMOTE_ENVIRONMENT_ID must be a stable lowercase identifier");
const SUPERVISOR_EPOCH = crypto.randomUUID();
const HOME = homedir();
const DATA = process.env.PI_REMOTE_DATA ?? join(process.env.XDG_STATE_HOME ?? join(HOME, ".local/state"), "pi-remote");
const INGESTION = process.env.PI_REMOTE_INGESTION ?? join(DATA, "ingestion");
const PI = process.env.PI_BIN ?? "pi";
const THREAD_NAMING_MODEL = threadNamingModel(process.env.PI_REMOTE_THREAD_NAMING_MODEL);
const THREAD_NAMING_DIR = join(DATA, "thread-naming");
const PRIVATE_ID = process.env.PI_REMOTE_PRIVATE_ID ?? "private";
const PRIVATE_NAME = process.env.PI_REMOTE_PRIVATE_NAME ?? "Private";
const PRIVATE_DIR = process.env.PI_REMOTE_PRIVATE_DIR ?? join(HOME, PRIVATE_ID);
const SERVICE_TIER_EXTENSION = join(import.meta.dir, "service-tier.ts");
const THREAD_CONTEXT_EXTENSION = join(import.meta.dir, "thread-context.ts");
const SERVICE_TIER_DIR = join(DATA, "service-tiers");
const ORCHESTRATOR_DB_PATH = process.env.PI_REMOTE_ORCHESTRATOR_DB ?? join(HOME, ".local/share/pi-orchestrator/ledger.sqlite3");
const ORCHESTRATOR_AUTH_PATH = process.env.PI_ORCHESTRATOR_AUTH ?? join(dirname(realpathSync(ORCHESTRATOR_DB_PATH)), "auth.json");
const ORCHESTRATOR_RUNS_ROOT = process.env.PI_REMOTE_ORCHESTRATOR_RUNS ?? join(HOME, ".local/share/pi-orchestrator/runs");
const HOST = process.env.PI_REMOTE_HOST ?? "127.0.0.1";
const PORT = Number(process.env.PI_REMOTE_PORT ?? "8788");
const AGENT_DIR = process.env.PI_AGENT_DIR ?? join(HOME, ".pi/agent");
const WEB_DIR = join(import.meta.dir, "../web/dist");
const PACKAGE_ROOT = realpathSync(join(import.meta.dir, ".."));
const RELEASE_COMMIT_PATH = join(PACKAGE_ROOT, ".pi-stack-commit");
const RELEASE_COMMIT = existsSync(RELEASE_COMMIT_PATH) ? readFileSync(RELEASE_COMMIT_PATH, "utf8").trim() : null;

function bashTimeoutSeconds(value: unknown): BashTimeoutSeconds {
  const seconds = Number(value);
  return BASH_TIMEOUT_OPTIONS.some((option) => option === seconds)
    ? seconds as BashTimeoutSeconds
    : DEFAULT_BASH_TIMEOUT_SECONDS;
}

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
// Both clients read these server profiles, whose models come from the orchestrator catalog.
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
const THREAD_MODELS = new Map(ORCHESTRATOR_CATALOG.models.map((model) => [model.id, {
  id: model.id,
  label: model.label,
  icon: model.icon,
  accent: model.accent,
  provider: model.provider,
  modelId: model.model,
}]));
// A destination that offers no model choice is started straight from its default, which is
// why the work machine has no second step: Anthropic models do not run there.
const OFFERED_DESTINATIONS = (process.env.PI_REMOTE_DESTINATIONS ?? "home").split(",").map((id) => id.trim()).filter(Boolean);
const destinationDefinitions = JSON.parse(process.env.PI_REMOTE_THREAD_DESTINATIONS ?? JSON.stringify([
  { id: "home", label: "HOME", icon: "house", accent: "#3fb950", workspaceId: "home", thinkingLevel: "high", models: ["astra", "fable", "opus"], defaultModel: "opus" },
])) as Array<{ id: string; label: string; icon: string; accent: string; workspaceId: string; thinkingLevel: string; models: string[]; defaultModel: string }>;
const THREAD_DESTINATIONS = new Map(destinationDefinitions
  .filter((destination) => OFFERED_DESTINATIONS.includes(destination.id))
  .map((destination) => [destination.id, destination]));

registerIconAssets([
  ...ORCHESTRATOR_CATALOG.plans.map((plan) => plan.icon),
  ...[...THREAD_MODELS.values()].map((model) => model.icon),
  ...[...THREAD_DESTINATIONS.values()].map((destination) => destination.icon),
]);
const machineActions = new MachineActions();

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

function knownPersons() {
  try { return listPersons().map(publicPerson); } catch { return []; }
}

function environmentMetadata() {
  return {
    id: ENVIRONMENT_ID,
    name: ENVIRONMENT_NAME,
    requiresUnlock: ENVIRONMENT_REQUIRES_UNLOCK,
    persons: knownPersons(),
    profiles: threadStartProfiles(),
    capabilities: { voice: true, downloads: true, notifications: true, files: true },
  };
}

const PLAN_USAGE_REFRESH_MS = Math.max(15_000, Number(process.env.PI_REMOTE_PLAN_USAGE_REFRESH_MS ?? "60000"));
const PROMPT_ACK_TIMEOUT_MS = Math.max(5, Number(process.env.PI_REMOTE_PROMPT_ACK_TIMEOUT_MS ?? "30000"));
const STATE_RECONCILE_MS = Math.max(5, Number(process.env.PI_REMOTE_STATE_RECONCILE_MS ?? "15000"));
const RUNTIME_RESTART_DELAY_MS = Math.max(5, Number(process.env.PI_REMOTE_RUNTIME_RESTART_DELAY_MS ?? "2000"));
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
mkdirSync(THREAD_NAMING_DIR, { recursive: true, mode: 0o700 });
mkdirSync(INGESTION, { recursive: true, mode: 0o700 });
const db = new Database(join(DATA, "supervisor.sqlite3"), { create: true, strict: true });
const orchestrator = new OrchestratorClient({
  ledgerPath: ORCHESTRATOR_DB_PATH,
  runsRoot: ORCHESTRATOR_RUNS_ROOT,
});
// Voice, plan cards, governor controls, and autonomous-run observation all
// consume the orchestrator's public model instead of its private tables.
const voiceAccounts = new VoiceBroker({
  authPath: ORCHESTRATOR_AUTH_PATH,
  agentDir: AGENT_DIR,
  accounts: () => orchestrator.voiceAccounts(),
  acquireLease: (accountId) => orchestrator.beginVoiceLease(accountId),
  releaseLease: (leaseId) => orchestrator.endLease(leaseId),
});
const agentHost = new AgentHost(orchestrator, { key: "local", label: "THIS MACHINE", name: "This machine" });
ensureSupervisorSchema(db);
const HANDOFF_PATH = join(DATA, "supervisor-handoff.json");
type RuntimePhase = "STARTING" | "IDLE" | "DISPATCHING" | "RUNNING" | "ABORTING" | "STOPPING";
type RuntimeHandoff = {
  sessionId: string;
  socketPath: string;
  pid?: number;
  phase: RuntimePhase;
  compacting: boolean;
  compactionContextHash: string | null;
  retrying: boolean;
  liveText: string;
  liveThinking: string;
  thinkingBlockStart?: number;
  pendingContextTextLength?: number;
  pendingContextThinkingLength?: number;
  pendingContextFinalization: string | null;
  pendingModelFailure: string | null;
  lastActivity: number;
  activeTools: Array<[string, string]>;
  dispatchedWorkIds: string[];
  steeringQueued: number;
  followUpQueued: number;
  historyNeedsRestore: boolean;
  modelId: string;
};
function loadHandoff(): RuntimeHandoff[] {
  if (!existsSync(HANDOFF_PATH)) return [];
  try {
    const document = JSON.parse(readFileSync(HANDOFF_PATH, "utf8"));
    if (document?.version !== 1 || !Array.isArray(document.runtimes)) throw new Error("invalid handoff document");
    return document.runtimes.filter((item: any) => typeof item?.sessionId === "string"
      && typeof item?.socketPath === "string");
  } catch (cause) {
    console.error("Could not read supervisor handoff", cause);
    return [];
  }
}
const pendingHandoff = loadHandoff();
beginSupervisorGeneration(db, SUPERVISOR_EPOCH, new Set(pendingHandoff.map((item) => item.sessionId)));

interface Runtime {
  transport: RuntimeTransport;
  pending: Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: Timer }>;
  phase: RuntimePhase;
  phaseVersion: number;
  compacting: boolean;
  compactionContextHash: string | null;
  retrying: boolean;
  reconciling: boolean;
  suppressOutput: boolean;
  liveText: string;
  liveThinking: string;
  thinkingBlockStart: number;
  pendingContextTextLength: number;
  pendingContextThinkingLength: number;
  pendingContextFinalization: string | null;
  pendingModelFailure: string | null;
  expectedExit: boolean;
  lastActivity: number;
  activeTools: Map<string, string>;
  dispatchedWorkIds: Set<string>;
  steeringQueued: number;
  followUpQueued: number;
  historyNeedsRestore: boolean;
  modelId: string;
  replaceAfterSettle: boolean;
}
const runtimes = new Map<string, Runtime>();
let runtimeAdoption = Promise.resolve();
const contextFinalizedMessages = new Map<string, string>();
// A runtime's phase changes underneath awaits and inside callees; reading it
// through a call keeps TypeScript from narrowing a value that has moved on.
const phaseOf = (rt: Runtime): RuntimePhase => rt.phase;
const activations = new Map<string, Promise<Runtime>>();
const sessionWorkers = new Map<string, Promise<void>>();
const forkingSessions = new Set<string>();
const retryTimers = new Map<string, Timer>();
let shuttingDown = false;
let releaseHandoffRequested = false;

const now = () => new Date().toISOString();
const serviceTierPath = (sessionId: string) => join(SERVICE_TIER_DIR, sessionId);
function writeServiceTier(sessionId: string, tier: "default" | "priority") {
  writeFileSync(serviceTierPath(sessionId), tier + "\n", { mode: 0o600 });
}
let planUsage: PlanUsageSnapshot | null = null;
let planUsageRefresh: Promise<void> | null = null;
let nextPlanUsageRefresh = 0;

function refreshPlanUsageIfDue() {
  if (planUsageRefresh || Date.now() < nextPlanUsageRefresh) return;
  nextPlanUsageRefresh = Date.now() + PLAN_USAGE_REFRESH_MS;
  planUsageRefresh = (async () => {
    try {
      await orchestrator.refreshPlanFacts(AGENT_DIR);
    } catch (cause) {
      console.error("Plan meter refresh failed", cause);
    }
    planUsage = orchestrator.plans();
  })().finally(() => { planUsageRefresh = null; });
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    ...API_CORS_HEADERS,
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-pi-state-version": `${SUPERVISOR_EPOCH}/${currentStateVersion()}`,
  },
});

function compressedJson(req: Request, data: unknown, status = 200): Response {
  const encoded = JSON.stringify(data);
  const headers: Record<string, string> = {
    ...API_CORS_HEADERS,
    "content-type": "application/json",
    "cache-control": "no-store",
    vary: "accept-encoding",
    "x-pi-state-version": `${SUPERVISOR_EPOCH}/${currentStateVersion()}`,
  };
  if (encoded.length >= 1_024 && /(?:^|,)\s*gzip(?:\s*;|\s*,|$)/i.test(req.headers.get("accept-encoding") ?? "")) {
    headers["content-encoding"] = "gzip";
    return new Response(Bun.gzipSync(Buffer.from(encoded)), { status, headers });
  }
  return new Response(encoded, { status, headers });
}

let syncSequence = 1;
let inMemoryStateVersion = 1;
const totalChangesRow = db.query("SELECT total_changes() AS value");
function currentStateVersion(): number {
  return inMemoryStateVersion + Number((totalChangesRow.get() as any)?.value ?? 0);
}
const syncWaiters = new Set<() => void>();
function wakeSync() {
  syncSequence++;
  for (const wake of syncWaiters) wake();
}
function signalSync() {
  inMemoryStateVersion++;
  wakeSync();
}

// The drawer footer and the Orchestrator tab change on their own clock:
// meters, load, agent lifecycles, and host toggles. None of that is
// supervisor SQLite, so it gets its own version. A client echoes the version
// it rendered; a tick that finds the snapshot unchanged does not wake anyone.
const DASHBOARD_TICK_MS = Math.max(1_000, Number(process.env.PI_REMOTE_DASHBOARD_TICK_MS ?? "10000"));
const DASHBOARD_IDLE_MS = 60_000;
let dashboardVersion = 1;
let dashboardSnapshot: Dashboard | null = null;
let dashboardEncoded = "";
let dashboardRefreshes = Promise.resolve();
let dashboardBusy = false;
let lastSyncRequestAt = 0;
async function buildDashboard(): Promise<Dashboard> {
  const [agents, actions] = await Promise.all([activeAgents(), machineActions.refresh()]);
  return {
    plans: planCards(planUsage),
    governors: governorControls(orchestrator),
    actions,
    machine: readMachineUsage(),
    agents: { runs: agents.runs, hosts: agents.hosts, running: agents.running },
    modelCounts: agents.models,
    threadStarts: threadStartProfiles(),
    home: HOME,
  };
}
// Refreshes are serialized so a toggle's refresh always observes the toggle,
// even when a tick's refresh was already in flight when the toggle landed.
function refreshDashboard(): Promise<void> {
  const run = dashboardRefreshes.then(async () => {
    dashboardBusy = true;
    try {
      refreshPlanUsageIfDue();
      const next = await buildDashboard();
      const encoded = JSON.stringify(next);
      if (encoded === dashboardEncoded) return;
      dashboardSnapshot = next;
      dashboardEncoded = encoded;
      dashboardVersion++;
      wakeSync();
    } catch (cause) {
      console.error("Dashboard refresh failed", cause);
    } finally {
      dashboardBusy = false;
    }
  });
  dashboardRefreshes = run;
  return run;
}
const dashboardTicker = setInterval(() => {
  if (!dashboardBusy && Date.now() - lastSyncRequestAt < DASHBOARD_IDLE_MS) void refreshDashboard();
}, DASHBOARD_TICK_MS);

const LIVE_SYNC_INTERVAL_MS = 16;
let liveSyncTimer: ReturnType<typeof setTimeout> | null = null;
let liveSyncPending = false;
function signalLiveSync() {
  if (liveSyncTimer) {
    liveSyncPending = true;
    return;
  }
  wakeSync();
  liveSyncTimer = setTimeout(() => {
    liveSyncTimer = null;
    if (liveSyncPending) {
      liveSyncPending = false;
      signalLiveSync();
    }
  }, LIVE_SYNC_INTERVAL_MS);
}

async function awaitSync(request: SyncRequest, signal: AbortSignal) {
  const after = Math.max(0, Number(request.seq ?? 0) || 0);
  const waitMs = Math.min(30_000, Math.max(0, Number(request.waitMs ?? 25_000) || 0));
  const synchronized = () => {
    if (request.epoch !== SUPERVISOR_EPOCH
      || request.stateVersion !== undefined && request.stateVersion !== currentStateVersion()
      || request.dashboardVersion !== undefined && request.dashboardVersion !== dashboardVersion) return false;
    if (request.agent || request.session?.eventsAfter !== undefined || !request.session) return after === syncSequence;
    const { id, contextHash, liveTextHash, liveThinkingHash } = request.session;
    const stored = storedContext(id);
    const runtime = runtimes.get(id);
    return (stored ? displayContext(id, stored.hash, stored.document).hash === contextHash : !contextHash)
      && sha256(runtime?.liveText ?? "") === liveTextHash
      && sha256(runtime?.liveThinking ?? "") === liveThinkingHash;
  };
  if (!synchronized() || !waitMs || signal.aborted) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(versionCheck);
      syncWaiters.delete(check);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const check = () => { if (!synchronized()) finish(); };
    const timer = setTimeout(finish, waitMs);
    const versionCheck = setInterval(check, 100);
    syncWaiters.add(check);
    signal.addEventListener("abort", finish, { once: true });
  });
}

const contextVersions = new DocumentHistory();
const storedContextCache = new Map<string, { capturedAt: number; document: string; hash: string } | null>();
const displayContexts = new Map<string, { sourceHash: string; document: string; hash: string; images: Map<string, ContextImage> }>();
function rememberContext(sessionId: string, document: string): string {
  return contextVersions.remember(sessionId, document);
}

function streamedThinkingByMessage(sessionId: string): Map<string, string> {
  const result = new Map<string, string>();
  const rows = db.query("SELECT payload FROM events WHERE session_id=? AND type='thinking' ORDER BY seq").all(sessionId) as Array<{ payload: string }>;
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload);
      if (typeof payload.finalizesMessage === "string" && typeof payload.text === "string" && payload.text)
        result.set(payload.finalizesMessage, payload.text);
    } catch {}
  }
  return result;
}

function displayContext(sessionId: string, sourceHash: string, sourceDocument: string) {
  const cached = displayContexts.get(sessionId);
  if (cached?.sourceHash === sourceHash) {
    displayContexts.delete(sessionId);
    displayContexts.set(sessionId, cached);
    return cached;
  }
  const images = new Map<string, ContextImage>();
  const document = displayContextDocument(sourceDocument, streamedThinkingByMessage(sessionId), (image) => {
    const hash = sha256(`${image.mimeType}\0${image.data}`);
    images.set(hash, image);
    return API.sessionImage.path({ sessionId, hash });
  });
  const projected = { sourceHash, document, hash: rememberContext(sessionId, document), images };
  displayContexts.delete(sessionId);
  displayContexts.set(sessionId, projected);
  while (displayContexts.size > 4) displayContexts.delete(displayContexts.keys().next().value!);
  return projected;
}

function textUpdate(key: string, baseHash: unknown, target: string): DocumentUpdate | null {
  const targetHash = rememberContext(key, target);
  if (baseHash === targetHash) return null;
  const base = typeof baseHash === "string" ? contextVersions.get(key, baseHash) : undefined;
  return base === undefined
    ? { kind: "full", capturedAt: Date.now(), hash: targetHash, document: target }
    : { kind: "splice", capturedAt: Date.now(), hash: targetHash, splice: contextSplice(base, target) };
}

function cacheStoredContext(sessionId: string, stored: { capturedAt: number; document: string; hash: string } | null) {
  storedContextCache.delete(sessionId);
  storedContextCache.set(sessionId, stored);
  while (storedContextCache.size > 4) storedContextCache.delete(storedContextCache.keys().next().value!);
}

function storedContext(sessionId: string): { capturedAt: number; document: string; hash: string } | null {
  if (storedContextCache.has(sessionId)) {
    const stored = storedContextCache.get(sessionId) ?? null;
    cacheStoredContext(sessionId, stored);
    return stored;
  }
  const stored = readContext(db, sessionId);
  cacheStoredContext(sessionId, stored);
  return stored;
}

function clearStoredContext(sessionId: string) {
  db.transaction(() => {
    db.query("DELETE FROM session_context_patches WHERE session_id=?").run(sessionId);
    db.query("DELETE FROM session_contexts WHERE session_id=?").run(sessionId);
  })();
  contextVersions.delete(sessionId);
  cacheStoredContext(sessionId, null);
  displayContexts.delete(sessionId);
  signalSync();
}

function requireCompactionContext(sessionId: string, rt: Runtime) {
  const stored = storedContext(sessionId);
  if (!rt.compactionContextHash || stored?.hash !== rt.compactionContextHash) clearStoredContext(sessionId);
  rt.compactionContextHash = null;
}

function acknowledgeMessageContext(sessionId: string, finalizesMessage: unknown) {
  if (typeof finalizesMessage !== "string" || !finalizesMessage) return;
  contextFinalizedMessages.set(sessionId, finalizesMessage);
  const rt = runtimes.get(sessionId);
  if (!rt || rt.pendingContextFinalization !== finalizesMessage) return;
  rt.pendingContextFinalization = null;
  rt.liveText = rt.liveText.slice(Math.min(rt.pendingContextTextLength, rt.liveText.length));
  const removedThinkingLength = Math.min(rt.pendingContextThinkingLength, rt.liveThinking.length);
  rt.liveThinking = rt.liveThinking.slice(removedThinkingLength);
  rt.thinkingBlockStart = Math.max(0, rt.thinkingBlockStart - removedThinkingLength);
  rt.pendingContextTextLength = 0;
  rt.pendingContextThinkingLength = 0;
  signalLiveSync();
  kickSession(sessionId);
}

const error = (message: string, status = 400) => json({ error: message }, status);

async function sessionFileResponse(url: URL, method: string, req: Request): Promise<Response | null> {
  const match = API.sessionFiles.match(method, url.pathname) ?? API.sessionFilesHead.match(method, url.pathname);
  if (!match) return null;
  const row = sessionRow.get(match.sessionId) as any;
  if (!row) return new Response("Session not found", { status: 404, headers: API_CORS_HEADERS });
  return localFileResponse(url.searchParams.get("path") ?? "", method, req);
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

const sessionRow = db.query("SELECT * FROM sessions WHERE id=?");
const activeSessionRows = db.query(
  "SELECT * FROM sessions WHERE archived_at IS NULL ORDER BY display_order ASC, created_at DESC",
);
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

function recordThinkingEvent(sessionId: string, text: string, finalizesMessage: string) {
  if (!ownsSupervisorLease() || !text) return;
  displayContexts.delete(sessionId);
  emit(sessionId, "thinking", { text, finalizesMessage });
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
  if (sequence) scheduleThreadNameIfDue(sessionId);
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
  if (releaseHandoffRequested && ![...runtimes.values()].some((runtime) => runtime.phase === "ABORTING")) {
    queueMicrotask(() => void handoffRelease());
  }
}
function runtimeWorking(rt: Runtime | undefined): boolean {
  return !!rt && ["STARTING", "DISPATCHING", "RUNNING", "ABORTING"].includes(rt.phase);
}
function nextThreadName(): string {
  const current = Number((db.query("SELECT value FROM metadata WHERE key='last_thread_number'").get() as any)?.value ?? 0);
  const next = current + 1;
  db.query("UPDATE metadata SET value=? WHERE key='last_thread_number'").run(String(next));
  return String(next);
}

const pendingThreadNames = new Map<string, number>();
const namingThreads = new Set<string>();

function recentThreadTranscript(sessionId: string): string {
  return (db.query(`
    SELECT type,payload FROM events
    WHERE session_id=? AND type IN ('user','assistant')
    ORDER BY seq DESC LIMIT ?
  `).all(sessionId, THREAD_NAMING_HISTORY) as any[]).reverse().map((event) => {
    const payload = JSON.parse(event.payload);
    return `${event.type === "user" ? "User" : "Agent"}: ${String(payload.text ?? "").slice(0, 3_000)}`;
  }).join("\n\n");
}

async function nameThread(sessionId: string): Promise<void> {
  const transcript = recentThreadTranscript(sessionId);
  if (!transcript) return;
  const scratch = mkdtempSync(join(THREAD_NAMING_DIR, `${sessionId}-`));
  const transcriptPath = join(scratch, "messages.txt");
  writeFileSync(transcriptPath, transcript, { mode: 0o600 });
  try {
    const child = Bun.spawn([
      PI,
      "--print",
      "--no-session",
      "--no-tools",
      "--no-skills",
      "--no-context-files",
      "--model", THREAD_NAMING_MODEL,
      "--system-prompt", THREAD_NAMING_INSTRUCTION,
      `@${transcriptPath}`,
    ], {
      cwd: HOME,
      env: {
        ...process.env,
        HOME,
        PATH: `${join(HOME, ".local/bin")}:${join(HOME, ".bun/bin")}:${process.env.PATH ?? ""}`,
        PI_CODING_AGENT_DIR: AGENT_DIR,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const timeout = setTimeout(() => child.kill(), 60_000);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]).finally(() => clearTimeout(timeout));
    if (exitCode !== 0) throw new Error(stderr.trim() || `Pi exited ${exitCode}`);
    const name = generatedThreadName(stdout);
    const row = sessionRow.get(sessionId) as any;
    if (!row || !ownsSupervisorLease()) return;
    const messageCount = Number((db.query("SELECT COUNT(*) count FROM events WHERE session_id=? AND type IN ('user','assistant')").get(sessionId) as any)?.count ?? 0);
    db.query("UPDATE sessions SET name=?,named_at_message_count=?,updated_at=?,revision=revision+1 WHERE id=?")
      .run(name, messageCount, now(), sessionId);
    signalSync();
    const runtime = runtimes.get(sessionId);
    if (runtime && runtime.phase !== "STOPPING") {
      try { await rpc(runtime, "set_session_name", { name }, 10_000); }
      catch (cause) { console.error(`Pi Remote could not copy thread name into runtime ${sessionId}: ${cause instanceof Error ? cause.message : cause}`); }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function drainThreadNames(sessionId: string): Promise<void> {
  if (namingThreads.has(sessionId)) return;
  namingThreads.add(sessionId);
  try {
    while (pendingThreadNames.delete(sessionId)) {
      const row = sessionRow.get(sessionId) as any;
      if (!row) continue;
      const count = Number((db.query("SELECT COUNT(*) count FROM events WHERE session_id=? AND type IN ('user','assistant')").get(sessionId) as any)?.count ?? 0);
      if (!shouldNameThread(String(row.name), count, Number(row.named_at_message_count ?? 0))) continue;
      try {
        await nameThread(sessionId);
      } catch (cause) {
        console.error(`Pi Remote could not name thread ${sessionId}: ${cause instanceof Error ? cause.message : cause}`);
      }
    }
  } finally {
    namingThreads.delete(sessionId);
  }
}

function scheduleThreadNameIfDue(sessionId: string) {
  const row = sessionRow.get(sessionId) as any;
  if (!row || !runtimes.has(sessionId)) return;
  const count = Number((db.query("SELECT COUNT(*) count FROM events WHERE session_id=? AND type IN ('user','assistant')").get(sessionId) as any)?.count ?? 0);
  if (!shouldNameThread(String(row.name), count, Number(row.named_at_message_count ?? 0))) return;
  pendingThreadNames.set(sessionId, count);
  void drainThreadNames(sessionId);
}

const agentModelOrder = new Map(ORCHESTRATOR_CATALOG.agentOrder.map((key, index) => [key, index]));
function addAgentModel(models: Map<string, AgentModelCount>, raw: string, count = 1) {
  if (count <= 0) return;
  const type = catalogAgentType(raw);
  const current = models.get(type.key);
  if (current) current.count += count;
  else models.set(type.key, { ...type, count });
}
function sortedAgentModels(models: Map<string, AgentModelCount>): AgentModelCount[] {
  return [...models.values()].sort((left, right) =>
    (agentModelOrder.get(left.key) ?? 999) - (agentModelOrder.get(right.key) ?? 999) || left.label.localeCompare(right.label));
}
async function activeAgents() {
  await agentHost.refresh();
  const snapshot = agentHost.cached();
  const models = new Map<string, AgentModelCount>();
  for (const row of snapshot.models) addAgentModel(models, row.model, row.count);
  for (const rt of runtimes.values()) if (runtimeWorking(rt)) addAgentModel(models, rt.modelId || "unknown");
  return {
    runs: snapshot.runs,
    running: snapshot.running,
    models: sortedAgentModels(models),
    hosts: [{ ...agentHost.ref, running: snapshot.running, updatedAt: snapshot.updatedAt, error: snapshot.error }],
  };
}
function supervisorState(): SupervisorState {
  return {
    sessions: publicSessions(activeSessionRows.all() as any[]),
    archived: publicSessions(archivedPage(0, ARCHIVED_PAGE_SIZE)),
    archivedTotal: archivedCount(),
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

function publicSession(row: any, prepared?: PreparedQueue): Session {
  const rt = runtimes.get(row.id);
  const preset = workspaces.get(row.workspace_id);
  const cwd = preset?.path ?? row.workspace_id;
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
  const queuedMessages: QueuedMessage[] = queuedSource.map((item) => ({
    id: String(item.id),
    text: String(item.text),
    delivery: String(item.delivery),
    state: String(item.state),
    status: item.state === "dispatched" ? "Sent · awaiting confirmation"
      : item.state === "running" ? "Sending to agent"
      : item.delivery === "hardSteer" ? "Aborting current operation · steering next"
      : item.delivery === "steer" ? "Steering after current tool calls"
      : item.delivery === "followUp" ? "Queued for after completion"
      : "Sending to agent",
    canSteer: item.state === "queued" && item.delivery === "followUp",
    canHardSteer: item.state === "queued" && item.delivery === "followUp",
    canCancel: item.state === "queued",
    createdAt: String(item.created_at),
    lastError: item.last_error ?? null,
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
    id: String(row.id),
    name: String(row.name ?? ""),
    cwd,
    workspaceName: preset?.name ?? cwd,
    environment: String(row.profile_id ?? ""),
    state: String(row.state),
    activity,
    activeTool: toolNames.at(-1) ?? null,
    provider: String(row.current_provider ?? row.initial_provider ?? "").toLowerCase().startsWith("anthropic") ? "anthropic" : "openai",
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    revision: Number(row.revision ?? 0),
    lastError: row.last_error ?? null,
    steeringQueued: durableSteering + (rt?.steeringQueued ?? 0),
    followUpQueued: durableFollowUps + (rt?.followUpQueued ?? 0),
    queuedMessages,
    archivedAt: row.archived_at ?? null,
  };
}
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block: any) => block?.type === "text").map((block: any) => String(block.text ?? "")).join("");
}

function textFromMessage(message: any): string {
  return message?.role === "assistant" ? contentText(message.content) : "";
}

function thinkingFromMessage(message: any): string {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content
    .filter((block: any) => block?.type === "thinking")
    .map((block: any) => String(block.thinking ?? ""))
    .join("");
}

function activeSessionEntries(entries: any[], leafId: unknown): any[] {
  const byId = new Map(entries.map((entry) => [String(entry?.id ?? ""), entry]));
  const branch: any[] = [];
  const visited = new Set<string>();
  let id = typeof leafId === "string" ? leafId : "";
  while (id) {
    if (visited.has(id)) throw new Error("Session branch contains a cycle");
    visited.add(id);
    const entry = byId.get(id);
    if (!entry) throw new Error("Session branch is missing an entry");
    branch.push(entry);
    id = typeof entry.parentId === "string" ? entry.parentId : "";
  }
  return branch.reverse();
}

function replaceConversationEvents(sessionId: string, entries: any[]) {
  db.transaction(() => {
    db.query("DELETE FROM events WHERE session_id=?").run(sessionId);
    const insert = db.query("INSERT INTO events(session_id,time,type,payload) VALUES(?,?,?,?)");
    for (const entry of entries) {
      if (entry?.type !== "message") continue;
      const message = entry.message;
      const time = typeof entry.timestamp === "string" ? entry.timestamp : now();
      if (message?.role === "user") {
        const text = contentText(message.content);
        if (text) insert.run(sessionId, time, "user", JSON.stringify({ text, delivery: "prompt" }));
      } else if (message?.role === "assistant") {
        const thinking = Array.isArray(message.content)
          ? message.content.filter((block: any) => block?.type === "thinking").map((block: any) => String(block.thinking ?? "")).join("")
          : "";
        const text = contentText(message.content);
        if (thinking) insert.run(sessionId, time, "thinking", JSON.stringify({ text: thinking }));
        if (text) insert.run(sessionId, time, "assistant", JSON.stringify({ text }));
      }
    }
  })();
  signalSync();
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
  rt.transport.send(value);
}

async function terminateRuntimeProcess(rt: Runtime) {
  await rt.transport.terminate();
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
  if (phaseOf(rt) === "STOPPING" || rt.suppressOutput) return;
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
    signalLiveSync();
  } else if (event.type === "message_update" && event.assistantMessageEvent?.type === "thinking_start") {
    proveRunning();
    // A provider can open several thinking content blocks in one assistant
    // message. Keep their deltas together until message_end identifies the
    // durable message that owns them.
    rt.thinkingBlockStart = rt.liveThinking.length;
    touchSession(sessionId);
  } else if (event.type === "message_update" && event.assistantMessageEvent?.type === "thinking_delta") {
    proveRunning();
    rt.liveThinking += event.assistantMessageEvent.delta ?? "";
    signalLiveSync();
  } else if (event.type === "message_update" && event.assistantMessageEvent?.type === "thinking_end") {
    const block = String(event.assistantMessageEvent.content ?? "");
    if (block && rt.liveThinking.length === rt.thinkingBlockStart) rt.liveThinking += block;
    touchSession(sessionId);
  } else if (event.type === "message_end") {
    proveRunning();
    const text = textFromMessage(event.message);
    if (event.message?.role === "assistant") {
      const textPrefix = rt.liveText.slice(0, Math.min(rt.pendingContextTextLength, rt.liveText.length));
      if (text) rt.liveText = textPrefix + text;
      const thinkingPrefix = rt.liveThinking.slice(0, Math.min(rt.pendingContextThinkingLength, rt.liveThinking.length));
      const streamedThinking = rt.liveThinking.slice(thinkingPrefix.length);
      const completedThinking = thinkingFromMessage(event.message) || streamedThinking;
      if (completedThinking) rt.liveThinking = thinkingPrefix + completedThinking;
      const finalization = messageFinalizationKey(event.message);
      recordThinkingEvent(sessionId, completedThinking, finalization);
      if (contextFinalizedMessages.get(sessionId) === finalization) {
        rt.pendingContextFinalization = null;
        rt.liveText = "";
        rt.liveThinking = "";
        rt.thinkingBlockStart = 0;
        rt.pendingContextTextLength = 0;
        rt.pendingContextThinkingLength = 0;
      } else {
        rt.pendingContextFinalization = finalization;
        rt.pendingContextTextLength = rt.liveText.length;
        rt.pendingContextThinkingLength = rt.liveThinking.length;
        rt.thinkingBlockStart = rt.liveThinking.length;
      }
    }
    if (text) {
      emit(sessionId, "assistant", { text });
      scheduleThreadNameIfDue(sessionId);
    }
    const failure = modelFailureText(event.message);
    if (failure) rt.pendingModelFailure = failure;
    else if (event.message?.role === "assistant") rt.pendingModelFailure = null;
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
    rt.compactionContextHash = null;
    touchSession(sessionId);
    emit(sessionId, "notice", { text: "Compacting context…" });
  } else if (event.type === "compaction_end") {
    rt.compacting = false;
    if (event.result) requireCompactionContext(sessionId, rt);
    else rt.compactionContextHash = null;
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
      void verifyRuntimeSettlement(sessionId, rt).catch((cause) => {
        console.error(`Settlement verification failed for ${sessionId}`, cause);
      });
    }
  }
}

async function verifyRuntimeSettlement(sessionId: string, rt: Runtime) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (!ownsSupervisorLease() || runtimes.get(sessionId) !== rt || rt.phase !== "RUNNING") return;
  await reconcileRuntimeState(sessionId, rt);
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
  if (!rt.pendingContextFinalization) {
    rt.liveText = "";
    rt.liveThinking = "";
    rt.thinkingBlockStart = 0;
    rt.pendingContextTextLength = 0;
    rt.pendingContextThinkingLength = 0;
  }
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
  if (rt.replaceAfterSettle && pendingWork === 0) {
    rt.expectedExit = true;
    rt.suppressOutput = true;
    setRuntimePhase(sessionId, rt, "STOPPING");
    void terminateRuntimeProcess(rt);
  } else {
    kickSession(sessionId);
  }
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
    const wasCompacting = rt.compacting;
    rt.compacting = Boolean(state.isCompacting);
    if (wasCompacting && !rt.compacting) requireCompactionContext(sessionId, rt);
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

function runtimeFromHandoff(row: any, handoff?: RuntimeHandoff): Runtime {
  return {
    transport: null as unknown as RuntimeTransport,
    pending: new Map(),
    phase: handoff?.phase ?? "STARTING",
    phaseVersion: 0,
    compacting: handoff?.compacting ?? false,
    compactionContextHash: handoff?.compactionContextHash ?? null,
    retrying: handoff?.retrying ?? false,
    reconciling: false,
    suppressOutput: false,
    liveText: handoff?.liveText ?? "",
    liveThinking: handoff?.liveThinking ?? "",
    thinkingBlockStart: handoff?.thinkingBlockStart ?? handoff?.liveThinking.length ?? 0,
    pendingContextTextLength: handoff?.pendingContextTextLength
      ?? (handoff?.pendingContextFinalization ? handoff.liveText.length : 0),
    pendingContextThinkingLength: handoff?.pendingContextThinkingLength
      ?? (handoff?.pendingContextFinalization ? handoff.liveThinking.length : 0),
    pendingContextFinalization: handoff?.pendingContextFinalization ?? null,
    pendingModelFailure: handoff?.pendingModelFailure ?? null,
    expectedExit: false,
    lastActivity: handoff?.lastActivity ?? Date.now(),
    activeTools: new Map(handoff?.activeTools ?? []),
    dispatchedWorkIds: new Set(handoff?.dispatchedWorkIds ?? []),
    steeringQueued: handoff?.steeringQueued ?? 0,
    followUpQueued: handoff?.followUpQueued ?? 0,
    historyNeedsRestore: handoff?.historyNeedsRestore ?? false,
    modelId: handoff?.modelId ?? String(row.initial_model ?? "unknown"),
    replaceAfterSettle: handoff !== undefined,
  };
}

function handleRuntimeOutput(sessionId: string, rt: Runtime, line: string) {
  try { handleRpcEvent(sessionId, rt, JSON.parse(line)); }
  catch { emit(sessionId, "notice", { text: "Malformed agent event ignored" }); }
}

function monitorRuntime(row: any, rt: Runtime) {
  rt.transport.onExit((code) => {
    for (const pending of rt.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Agent stopped")); }
    rt.pending.clear();
    if (runtimes.get(row.id) !== rt) return;
    setRuntimePhase(row.id, rt, "STOPPING");
    runtimes.delete(row.id);
    if (shuttingDown || !ownsSupervisorLease()) return;
    const retryAt = Date.now() + RUNTIME_RESTART_DELAY_MS;
    if (!rt.expectedExit) {
      db.query("UPDATE work_items SET state='queued',resume=1,available_at=?,updated_at=?,last_error='Agent stopped before settling' WHERE session_id=? AND state='dispatched'")
        .run(retryAt, now(), row.id);
    }
    rt.dispatchedWorkIds.clear();
    if (!sessionRow.get(row.id)) return;
    const pendingWork = Number((db.query(
      "SELECT COUNT(*) count FROM work_items WHERE session_id=? AND state IN ('queued','running')",
    ).get(row.id) as any)?.count ?? 0);
    if (rt.expectedExit) {
      setState(row.id, "STOPPED");
    } else if (pendingWork > 0) {
      setState(row.id, "RUNNING", `Agent exited ${code}; resuming queued work`);
      emit(row.id, "notice", { text: `Agent disconnected (exit ${code}); resuming queued work` });
      scheduleSession(row.id, RUNTIME_RESTART_DELAY_MS);
    } else {
      setState(row.id, "STOPPED", code === 0 ? null : `Agent exited ${code}`);
      emit(row.id, "notice", { text: `Agent disconnected while idle (exit ${code}); thread remains resumable` });
    }
  });
}

function runtimeEnvironment(row: any) {
  return {
    ...process.env,
    HOME,
    PATH: `${join(HOME, ".local/bin")}:${join(HOME, ".bun/bin")}:${process.env.PATH ?? ""}`,
    PI_REMOTE_SESSION_ID: row.id,
    PI_REMOTE_CONTEXT_OWNER_PID: "",
    PI_REMOTE_BASH_TIMEOUT_MAX_SECONDS: String(bashTimeoutSeconds(row.bash_timeout_seconds)),
    PI_REMOTE_SERVICE_TIER_FILE: serviceTierPath(row.id),
    PI_REMOTE_SERVER_URL: `http://${HOST}:${PORT}`,
    PI_CODING_AGENT_DIR: AGENT_DIR,
  };
}

async function startRuntime(row: any): Promise<Runtime> {
  const preset = workspaces.get(row.workspace_id);
  const cwd = realpathSync(preset?.path ?? row.workspace_id);
  const resumePath = row.session_path && existsSync(row.session_path) ? row.session_path : null;
  if (row.session_path && !resumePath) {
    db.query("UPDATE sessions SET session_path=NULL WHERE id=?").run(row.id);
    emit(row.id, "notice", { text: "Session file was missing; restoring from saved conversation history" });
  }
  writeServiceTier(row.id, row.service_tier === "priority" ? "priority" : "default");
  const args = [
    PI, "--mode", "rpc", "--session-dir", join(DATA, "sessions"),
    "--extension", SERVICE_TIER_EXTENSION,
    "--extension", THREAD_CONTEXT_EXTENSION,
  ];
  if (resumePath) args.push("--session", resumePath);
  else {
    args.push("--name", row.name);
    if (row.initial_provider && row.initial_model) args.push("--provider", row.initial_provider, "--model", row.initial_model);
    if (row.initial_thinking) args.push("--thinking", row.initial_thinking);
  }
  setState(row.id, "STARTING");
  const rt = runtimeFromHandoff(row);
  runtimes.set(row.id, rt);
  try {
    rt.transport = await startRuntimeHost({
      data: DATA,
      sessionId: row.id,
      cwd,
      args,
      env: runtimeEnvironment(row),
      onOutput: (line) => handleRuntimeOutput(row.id, rt, line),
    });
    monitorRuntime(row, rt);
    const state = await rpc(rt, "get_state", {}, 120_000);
    if (!ownsSupervisorLease() || rt.phase !== "STARTING") throw new Error("Activation cancelled");
    if (state.model?.id) rt.modelId = String(state.model.id);
    if (state.sessionFile) db.query("UPDATE sessions SET session_path=? WHERE id=?").run(state.sessionFile, row.id);
    if (state.model?.provider) db.query("UPDATE sessions SET current_provider=?,revision=revision+1,updated_at=? WHERE id=?")
      .run(String(state.model.provider), now(), row.id);
    const latestRow = sessionRow.get(row.id) as any;
    if (latestRow && !/^\d+$/.test(String(latestRow.name)) && state.sessionName !== latestRow.name) {
      await rpc(rt, "set_session_name", { name: String(latestRow.name) }, 10_000);
    }
    const historyCount = (db.query("SELECT count(*) count FROM events WHERE session_id=? AND type IN ('user','assistant')").get(row.id) as any)?.count ?? 0;
    rt.historyNeedsRestore = Number(state.messageCount ?? 0) === 0 && historyCount > 0;
    const pendingWork = Number((db.query(
      "SELECT COUNT(*) AS count FROM work_items WHERE session_id=? AND state IN ('queued','running')",
    ).get(row.id) as any)?.count ?? 0);
    setRuntimePhase(row.id, rt, "IDLE", pendingWork > 0 ? "RUNNING" : "IDLE");
    if (rt.historyNeedsRestore) emit(row.id, "notice", { text: "Conversation context will be restored with the next message" });
    scheduleThreadNameIfDue(row.id);
    return rt;
  } catch (cause) {
    const cancelled = rt.expectedExit;
    rt.expectedExit = true;
    setRuntimePhase(row.id, rt, "STOPPING");
    if (rt.transport) await terminateRuntimeProcess(rt);
    if (cancelled || !ownsSupervisorLease()) throw cause;
    if (resumePath) {
      db.query("UPDATE sessions SET session_path=NULL WHERE id=?").run(row.id);
      emit(row.id, "notice", { text: "Session could not resume; restoring from saved conversation history" });
      return startRuntime({ ...row, session_path: null });
    }
    throw cause;
  }
}

function recoverFailedHandoff(sessionId: string) {
  const time = now();
  db.query("UPDATE sessions SET state='STOPPED',updated_at=?,last_error=NULL,revision=revision+1 WHERE id=?").run(time, sessionId);
  db.query("UPDATE work_items SET state='queued',resume=CASE WHEN state='dispatched' THEN 1 ELSE resume END,available_at=?,updated_at=? WHERE session_id=? AND state IN ('running','dispatched')")
    .run(Date.now(), time, sessionId);
}

async function terminateFailedHandoff(handoff: RuntimeHandoff) {
  const pid = Number(handoff.pid ?? 0);
  if (!Number.isSafeInteger(pid) || pid <= 1) return;
  try { process.kill(-pid, "SIGTERM"); } catch { return; }
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try { process.kill(-pid, 0); } catch { return; }
    await Bun.sleep(50);
  }
  try { process.kill(-pid, "SIGKILL"); } catch {}
}

async function reconcileAdoptedRuntime(row: any, rt: Runtime) {
  try {
    const state = await rpc(rt, "get_state", {}, 5_000);
    if (!ownsSupervisorLease() || runtimes.get(row.id) !== rt) return;
    if (state.model?.id) rt.modelId = String(state.model.id);
    if (state.sessionFile) db.query("UPDATE sessions SET session_path=? WHERE id=?").run(state.sessionFile, row.id);
    const active = Boolean(state.isStreaming || state.isCompacting || Number(state.pendingMessageCount ?? 0) > 0);
    if (active && !["RUNNING", "ABORTING"].includes(rt.phase)) setRuntimePhase(row.id, rt, "RUNNING", "RUNNING");
    else if (!active && rt.phase === "RUNNING") settleRuntime(row.id, rt, true);
    else if (!active && rt.phase === "STARTING") {
      setRuntimePhase(row.id, rt, "IDLE", "IDLE");
      rt.expectedExit = true;
      rt.suppressOutput = true;
      setRuntimePhase(row.id, rt, "STOPPING");
      void terminateRuntimeProcess(rt);
    }
  } catch (cause) {
    console.error(`Could not reconcile adopted runtime ${row.id}`, cause);
  }
}

async function adoptHandoffRuntimes() {
  await Promise.all(pendingHandoff.map(async (handoff) => {
    const row = sessionRow.get(handoff.sessionId) as any;
    if (!row) return;
    const rt = runtimeFromHandoff(row, handoff);
    runtimes.set(row.id, rt);
    try {
      rt.transport = await attachRuntimeHost(handoff.socketPath, (line) => handleRuntimeOutput(row.id, rt, line));
      monitorRuntime(row, rt);
      if (rt.phase === "IDLE") {
        rt.expectedExit = true;
        rt.suppressOutput = true;
        setRuntimePhase(row.id, rt, "STOPPING");
        void terminateRuntimeProcess(rt);
      } else {
        void reconcileAdoptedRuntime(row, rt);
      }
    } catch (cause) {
      console.error(`Could not adopt runtime ${row.id}`, cause);
      runtimes.delete(row.id);
      void (async () => {
        if (existsSync(handoff.socketPath)) await terminateFailedHandoff(handoff);
        recoverFailedHandoff(row.id);
        kickSession(row.id);
      })().catch((recoveryCause) => console.error(`Could not recover runtime ${row.id}`, recoveryCause));
    }
  }));
  try { unlinkSync(HANDOFF_PATH); } catch {}
  for (const sessionId of runtimes.keys()) scheduleThreadNameIfDue(sessionId);
}

async function reapUnclaimedRuntimeHosts() {
  const directory = join(DATA, "runtime-hosts");
  if (!existsSync(directory)) return;
  const claimed = new Set([...runtimes.values()].map((rt) => rt.transport.socketPath));
  await Promise.all(readdirSync(directory).filter((name) => name.endsWith(".sock")).map(async (name) => {
    const socketPath = join(directory, name);
    if (claimed.has(socketPath)) return;
    try {
      const transport = await attachRuntimeHost(socketPath, () => {});
      await transport.terminate();
    } catch {
      try { unlinkSync(socketPath); } catch {}
    }
  }));
}

async function activate(row: any): Promise<Runtime> {
  await runtimeAdoption;
  const current = sessionRow.get(row.id) as any;
  if (!current || current.archived_at) throw new Error("Thread is archived; unarchive it before continuing");
  row = current;
  const inProgress = activations.get(row.id);
  if (inProgress) return inProgress;
  const existing = runtimes.get(row.id);
  if (existing) return existing;
  const activation = startRuntime(row).finally(() => {
    activations.delete(row.id);
  });
  activations.set(row.id, activation);
  return activation;
}

function canonicalModelProvider(provider: string): string {
  if (/^openai-codex(?:-\d+)?$/.test(provider)) return "openai-codex";
  if (/^anthropic(?:-\d+)?$/.test(provider)) return "anthropic";
  return provider;
}

function commonModelRank(model: any): number {
  if (model.provider === "anthropic" && model.id === "claude-fable-5-1") return 0;
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
      if (phaseOf(rt) === "DISPATCHING") setRuntimePhase(row.id, rt, "RUNNING", "RUNNING");
      if (phaseOf(rt) === "RUNNING") settleRuntime(row.id, rt, true);
    } catch (cause) {
      if (phaseOf(rt) === "DISPATCHING") setRuntimePhase(row.id, rt, "IDLE", "IDLE");
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
    bashTimeoutSeconds: bashTimeoutSeconds(latest?.bash_timeout_seconds),
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
    if (!ownsSupervisorLease() || forkingSessions.has(sessionId)) return;
    const knownRuntime = runtimes.get(sessionId);
    if (knownRuntime && ["ABORTING", "STOPPING"].includes(knownRuntime.phase)) return;
    const runtimeBusy = knownRuntime && ["DISPATCHING", "RUNNING"].includes(knownRuntime.phase);
    const item = db.query(`
      SELECT * FROM work_items
      WHERE session_id=? AND state='queued' AND available_at<=?
        ${runtimeBusy ? "AND delivery='steer'" : ""}
      ORDER BY CASE WHEN delivery='hardSteer' THEN 0 ELSE 1 END,created_at,rowid LIMIT 1
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
        rt.thinkingBlockStart = 0;
        rt.pendingContextTextLength = 0;
        rt.pendingContextThinkingLength = 0;
        rt.pendingContextFinalization = null;
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
      emit(sessionId, "notice", { text: `Message retained; retrying in ${Math.round(delay / 1000)} seconds: ${String(cause?.message ?? cause)}` });
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

type AbortOperationResult =
  | { ok: true; aborting?: true; retainedQueued?: number }
  | { ok: false; status: 409; error: string };

async function hardSteerCurrentOperation(sessionId: string, workId: string): Promise<AbortOperationResult> {
  const rt = runtimes.get(sessionId);
  if (rt?.phase === "ABORTING") return { ok: false, status: 409, error: "Another abort is already in progress" };
  if (rt?.phase === "STOPPING") return { ok: false, status: 409, error: "Agent is already stopping" };
  const wasActive = !!rt && ["DISPATCHING", "RUNNING"].includes(rt.phase);

  if (rt && wasActive) {
    // Pi's ordinary abort waits for its already accepted steering queue to run.
    // Hard steer means preemption, so retire that process group instead: this
    // stops the provider request and every active tool before a new Pi process
    // receives the selected message.
    rt.expectedExit = true;
    rt.suppressOutput = true;
    setRuntimePhase(sessionId, rt, "STOPPING", "ABORTING");
    await terminateRuntimeProcess(rt);
    if (runtimes.get(sessionId) === rt) {
      rt.expectedExit = false;
      rt.suppressOutput = false;
      setRuntimePhase(sessionId, rt, "RUNNING", "RUNNING", "Could not stop the current operation for hard steer");
      return { ok: false, status: 409, error: "Could not stop the current operation; the agent is still running" };
    }
    await sessionWorkers.get(sessionId);
  }

  const fallbackCurrent = !wasActive ? db.query(`
    SELECT id FROM work_items
    WHERE session_id=? AND id<>? AND state IN ('queued','running','dispatched')
    ORDER BY created_at,rowid LIMIT 1
  `).get(sessionId, workId) as { id: string } | null : null;
  const changedAt = now();
  db.query(`
    UPDATE work_items
    SET state='cancelled',updated_at=?,last_error='Current turn stopped by hard steer'
    WHERE session_id=? AND id<>?
      AND (state IN ('running','dispatched') OR id=?)
  `).run(changedAt, sessionId, workId, fallbackCurrent?.id ?? "");
  const retainedQueued = Number((db.query(`
    SELECT COUNT(*) count FROM work_items
    WHERE session_id=? AND id<>? AND state='queued'
  `).get(sessionId, workId) as any)?.count ?? 0);
  setState(sessionId, "RUNNING");
  kickSession(sessionId);
  return { ok: true, retainedQueued };
}

async function abortCurrentOperation(sessionId: string): Promise<AbortOperationResult> {
  const activeItems = db.query(`
    SELECT rowid queue_order,id,state,inserted_at FROM work_items
    WHERE session_id=? AND state IN ('queued','running','dispatched')
    ORDER BY created_at,rowid
  `).all(sessionId) as any[];
  const rt = runtimes.get(sessionId);
  const activeRuntime = !!rt && ["DISPATCHING", "RUNNING", "ABORTING"].includes(rt.phase);
  const currentWork = activeItems.find((item) => item.state === "running" || item.state === "dispatched")
    ?? (!activeRuntime ? activeItems[0] : undefined);
  const retainedCount = activeItems.filter((item) => item.id !== currentWork?.id).length;
  if (rt?.phase === "ABORTING") return { ok: true, aborting: true };
  if (rt?.phase === "STOPPING") return { ok: false, status: 409, error: "Agent is pausing after inactivity" };

  if (!rt || rt.phase === "STARTING" || rt.phase === "IDLE") {
    if (currentWork) {
      db.query("UPDATE work_items SET state='cancelled',updated_at=?,last_error='Current turn stopped by user' WHERE id=?")
        .run(now(), currentWork.id);
    }
    const retryTimer = retryTimers.get(sessionId);
    if (retryTimer) clearTimeout(retryTimer);
    retryTimers.delete(sessionId);
    if (!rt) {
      setState(sessionId, retainedCount > 0 ? "RUNNING" : "STOPPED");
      if (retainedCount > 0) kickSession(sessionId);
    } else if (rt.phase === "IDLE") {
      rt.retrying = false;
      setRuntimePhase(sessionId, rt, "IDLE", retainedCount > 0 ? "RUNNING" : "IDLE");
      if (retainedCount > 0) kickSession(sessionId);
    } else {
      touchSession(sessionId);
    }
    return { ok: true, retainedQueued: retainedCount };
  }

  setRuntimePhase(sessionId, rt, "ABORTING", "ABORTING");
  let abortFailure: unknown = null;
  try { await rpc(rt, "abort", {}, 10_000); }
  catch (cause) { abortFailure = cause; }
  if (abortFailure) {
    try {
      const state = await rpc(rt, "get_state", {}, 2_000);
      const active = Boolean(state.isStreaming || state.isCompacting || Number(state.pendingMessageCount ?? 0) > 0);
      if (active) {
        setRuntimePhase(sessionId, rt, "RUNNING", "RUNNING", `Could not stop current operation: ${String((abortFailure as any)?.message ?? abortFailure)}`);
        return { ok: false, status: 409, error: "Could not stop the current operation; the agent is still running" };
      }
    } catch {
      setRuntimePhase(sessionId, rt, "RUNNING", "RUNNING", `Could not confirm stop: ${String((abortFailure as any)?.message ?? abortFailure)}`);
      return { ok: false, status: 409, error: "Could not confirm that the current operation stopped; the agent process was left running" };
    }
  }

  const changedAt = now();
  if (currentWork) {
    db.query("UPDATE work_items SET state='cancelled',updated_at=?,last_error='Current turn stopped by user' WHERE id=?")
      .run(changedAt, currentWork.id);
    rt.dispatchedWorkIds.delete(String(currentWork.id));
  }
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
  rt.thinkingBlockStart = 0;
  rt.pendingContextTextLength = 0;
  rt.pendingContextThinkingLength = 0;
  rt.pendingContextFinalization = null;
  rt.lastActivity = Date.now();
  const supervisorQueued = Number((db.query(
    "SELECT COUNT(*) count FROM work_items WHERE session_id=? AND state IN ('queued','running')",
  ).get(sessionId) as any)?.count ?? 0);
  setRuntimePhase(sessionId, rt, "IDLE", supervisorQueued > 0 ? "RUNNING" : "IDLE");
  if (supervisorQueued > 0) kickSession(sessionId);
  return { ok: true, retainedQueued: retainedCount };
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

runtimeAdoption = adoptHandoffRuntimes();
void runtimeAdoption.then(reapUnclaimedRuntimeHosts)
  .catch((cause) => console.error("Could not finish runtime adoption", cause));

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  idleTimeout: 30,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS" && url.pathname.startsWith("/v1/")) {
      return new Response(null, {
        status: 204,
        headers: { ...API_CORS_HEADERS, "access-control-max-age": "86400" },
      });
    }
    if (!ownsSupervisorLease()) return error("Supervisor instance was replaced", 503);
    const imageRequest = API.sessionImage.match(req.method, url.pathname);
    if (imageRequest) {
      const stored = storedContext(imageRequest.sessionId);
      const image = stored && displayContext(imageRequest.sessionId, stored.hash, stored.document).images.get(imageRequest.hash);
      if (!image || !/^image\/(png|jpeg|gif|webp|bmp|avif)$/.test(image.mimeType)) return error("Context image not found", 404);
      const headers = { ...API_CORS_HEADERS, "content-type": image.mimeType, "cache-control": "private, max-age=31536000, immutable", etag: `"${imageRequest.hash}"` };
      if (req.headers.get("if-none-match") === headers.etag) return new Response(null, { status: 304, headers });
      return new Response(Buffer.from(image.data, "base64"), { headers });
    }
    const deliveredFile = await sessionFileResponse(url, req.method, req);
    if (deliveredFile) return deliveredFile;
    if (API.fileDownload.match(req.method, url.pathname) || API.fileDownloadHead.match(req.method, url.pathname)) {
      return localFileResponse(url.searchParams.get("path") ?? "", req.method, req);
    }
    const web = webResponse(WEB_DIR, url.pathname, req.method);
    if (web) return web;
    if (API.health.match(req.method, url.pathname)) return json({ ok: true, version: VERSION, environmentId: ENVIRONMENT_ID, releaseCommit: RELEASE_COMMIT });
    if (API.environment.match(req.method, url.pathname)) return json({ environment: environmentMetadata() });
    if (API.environments.match(req.method, url.pathname)) return json({ environments: knownEnvironments() });
    if (API.files.match(req.method, url.pathname)) {
      const requested = url.searchParams.get("path") ?? "";
      if (!isAbsolute(requested)) return error("Valid absolute folder path required");
      try { return json({ directory: listDirectory(requested) }); }
      catch (cause: any) {
        const failure = fileBrowserError(cause);
        return error(failure.message, failure.status);
      }
    }
    if (API.voice.match(req.method, url.pathname)) {
      return json({ ...voiceAccounts.status(), model: DEFAULT_LIVE_MODEL, voice: DEFAULT_LIVE_VOICE });
    }
    if (API.voiceOffer.match(req.method, url.pathname)) {
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
          "x-pi-voice-lease": result.leaseId,
          ...API_CORS_HEADERS,
        },
      });
    }
    const voiceLeaseHeartbeat = API.voiceLeaseHeartbeat.match(req.method, url.pathname);
    if (voiceLeaseHeartbeat) {
      orchestrator.heartbeatLease(voiceLeaseHeartbeat.leaseId);
      return json({ ok: true });
    }
    const voiceLeaseRelease = API.voiceLeaseRelease.match(req.method, url.pathname);
    if (voiceLeaseRelease) {
      orchestrator.endLease(voiceLeaseRelease.leaseId);
      return json({ ok: true });
    }
    const governorToggle = API.governorToggle.match(req.method, url.pathname);
    if (governorToggle && isGovernorProvider(governorToggle.provider)) {
      try {
        const governors = toggleGovernor(orchestrator, governorToggle.provider);
        await refreshDashboard();
        return json({ governors });
      } catch (cause: any) { return error(cause?.message ?? "Could not toggle governor control", 503); }
    }
    if (API.actions.match(req.method, url.pathname)) {
      try { return json({ actions: await machineActions.refresh() }); }
      catch (cause: any) { return error(cause?.message ?? "Could not read machine actions", 503); }
    }
    const actionToggle = API.actionToggle.match(req.method, url.pathname);
    if (actionToggle) {
      const action = machineActions.find(actionToggle.id);
      if (!action) return error("Unknown machine action", 404);
      try {
        const state = await machineActions.toggle(action);
        await refreshDashboard();
        return json({ action: state });
      } catch (cause: any) { return error(cause?.message ?? "Could not toggle machine action", 503); }
    }
    if (API.uploadInit.match(req.method, url.pathname)) {
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
    const uploadChunk = API.upload.match(req.method, url.pathname);
    if (uploadChunk && /^[0-9a-f-]+$/i.test(uploadChunk.id)) {
      try {
        const transfer = db.query("SELECT * FROM upload_transfers WHERE id=?").get(uploadChunk.id) as any;
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
    const uploadComplete = API.uploadComplete.match(req.method, url.pathname);
    if (uploadComplete && /^[0-9a-f-]+$/i.test(uploadComplete.id)) {
      try {
        const transfer = db.query("SELECT * FROM upload_transfers WHERE id=?").get(uploadComplete.id) as any;
        if (!transfer) return error("Upload not found", 404);
        if (Number(transfer.received_size) !== Number(transfer.expected_size))
          return json({ error: "Upload is incomplete", offset: Number(transfer.received_size) }, 409);
        const body = await readBody(req);
        const data = await Bun.file(String(transfer.temp_path)).arrayBuffer();
        const fileHash = sha256(new Uint8Array(data));
        if (String(body.sha256 ?? "").toLowerCase() !== fileHash) return error("Completed upload hash does not match", 422);
        const uploadSession = sessionRow.get(String(transfer.session_id)) as any;
        if (!uploadSession) return error("Session not found", 404);
        mkdirSync(INGESTION, { recursive: true, mode: 0o700 });
        const destination = availableUploadPath(INGESTION, String(transfer.name));
        renameSync(String(transfer.temp_path), destination);
        const file = { name: basename(destination), path: destination, size: Number(transfer.expected_size) };
        db.transaction(() => {
          db.query("INSERT OR REPLACE INTO uploads(path,session_id,created_at) VALUES(?,?,?)")
            .run(file.path, transfer.session_id, now());
          db.query("DELETE FROM upload_transfers WHERE id=?").run(transfer.id);
        })();
        return json({ file: { ...file, sha256: fileHash, environment: "local" } }, 201);
      } catch (cause: any) { return error(cause?.message ?? "Could not complete upload", 400); }
    }
    if (API.uploads.match(req.method, url.pathname)) {
      try {
        const name = url.searchParams.get("name") ?? "";
        const uploadSessionId = url.searchParams.get("sessionId") ?? "";
        const uploadSession = uploadSessionId ? sessionRow.get(uploadSessionId) as any : null;
        if (uploadSessionId && !uploadSession) return error("Session not found", 404);
        const file = await storeUpload(req, name, INGESTION);
        if (uploadSession) db.query("INSERT OR REPLACE INTO uploads(path,session_id,created_at) VALUES(?,?,?)")
          .run(file.path, uploadSessionId, now());
        return json({ file: { ...file, environment: "local" } }, 201);
      } catch (cause: any) { return error(cause?.message ?? "Upload failed", 400); }
    }
    if (API.removeUploads.match(req.method, url.pathname)) {
      try {
        const requested = url.searchParams.get("name") ?? "";
        const name = uploadName(requested);
        if (name !== requested) return error("Invalid uploaded file name");
        const uploadSessionId = url.searchParams.get("sessionId") ?? "";
        const tracked = uploadSessionId
          ? db.query("SELECT path FROM uploads WHERE session_id=? AND path LIKE ?").get(uploadSessionId, `%/${name}`) as any
          : null;
        const path = tracked?.path ?? join(INGESTION, name);
        if (existsSync(path)) unlinkSync(path);
        if (tracked?.path) db.query("DELETE FROM uploads WHERE path=? AND session_id=?").run(tracked.path, uploadSessionId);
        return json({ ok: true });
      } catch (cause: any) { return error(cause?.message ?? "Could not remove upload", 400); }
    }
    // Read-only observation of this host's autonomous agents. There is no
    // prompt, steer, or abort surface here: the orchestrator owns their work.
    if (API.agentRuns.match(req.method, url.pathname)) {
      try { return json(await activeAgents()); }
      catch (cause: any) { return error(cause?.message ?? "Could not read agent runs", 503); }
    }
    const agentEvents = API.agentEvents.match(req.method, url.pathname);
    if (agentEvents) {
      const addressed = parseRunKey(agentEvents.runId);
      if (!addressed || addressed.host !== agentHost.key) return error("Invalid agent run", 400);
      try {
        const after = Math.max(0, Number(url.searchParams.get("after") ?? 0) || 0);
        const stream = await agentHost.events(addressed.runId, after);
        if (!stream.run) return error("Agent run not found", 404);
        return json({
          run: stream.run,
          events: stream.events,
          liveText: stream.liveText,
          liveThinking: stream.liveThinking,
        });
      } catch (cause: any) { return error(cause?.message ?? "Could not read the agent transcript", 503); }
    }
    if (API.notifications.match(req.method, url.pathname)) {
      const after = url.searchParams.has("after") ? Number(url.searchParams.get("after")) : null;
      if (after !== null && (!Number.isSafeInteger(after) || after < 0)) return error("Invalid notification cursor", 400);
      return json({ environmentId: ENVIRONMENT_ID, ...idleNotifications(db, after) });
    }
    if (API.workspaces.match(req.method, url.pathname)) {
      return json({ workspaces: [...workspaces.values()].map(({ id, name, path }) => ({ id, name, path })) });
    }
    if (API.sync.match(req.method, url.pathname)) {
      try {
        const request = await readBody(req) as SyncRequest;
        lastSyncRequestAt = Date.now();
        if (!dashboardSnapshot) await refreshDashboard();
        await awaitSync(request, req.signal);
        if (req.signal.aborted) return new Response(null, { status: 499 });
        const sequence = syncSequence;
        const stateVersion = currentStateVersion();
        const fresh = request.epoch !== SUPERVISOR_EPOCH;
        const state = request.stateVersion !== undefined && (fresh || request.stateVersion !== stateVersion) ? supervisorState() : null;
        const dashboard = request.dashboardVersion !== undefined && (fresh || request.dashboardVersion !== dashboardVersion) ? dashboardSnapshot : null;
        const response: SyncResponse = { epoch: SUPERVISOR_EPOCH, seq: sequence, stateVersion, dashboardVersion, state, dashboard, session: null, agent: null };
        const sessionId = typeof request.session?.id === "string" ? request.session.id : "";
        if (sessionId && sessionRow.get(sessionId)) {
          const id = sessionId;
          const { contextHash, liveTextHash, liveThinkingHash, eventsAfter } = request.session!;
          const stored = storedContext(id);
          let context: DocumentUpdate | null = { kind: "clear", capturedAt: 0, hash: "" };
          if (stored) {
            const display = displayContext(id, stored.hash, stored.document);
            const baseHash = typeof contextHash === "string" ? contextHash : "";
            if (baseHash === display.hash) context = null;
            else {
              const base = contextVersions.get(id, baseHash);
              context = base === undefined
                ? { kind: "full", capturedAt: stored.capturedAt, hash: display.hash, document: display.document }
                : { kind: "splice", capturedAt: stored.capturedAt, hash: display.hash, splice: contextSplice(base, display.document) };
            }
          }
          const runtime = runtimes.get(id);
          const events = eventsAfter === undefined ? [] : (db.query("SELECT seq,time,type,payload FROM events WHERE session_id=? AND seq>? ORDER BY seq LIMIT 150")
            .all(id, Math.max(0, Number(eventsAfter) || 0)) as any[]).map((entry) => ({ seq: entry.seq, time: entry.time, type: entry.type, ...JSON.parse(entry.payload) }));
          response.session = {
            context,
            liveText: textUpdate(`session:${id}:text`, liveTextHash, runtime?.liveText ?? ""),
            liveThinking: textUpdate(`session:${id}:thinking`, liveThinkingHash, runtime?.liveThinking ?? ""),
            events,
          };
        }
        if (typeof request.agent?.id === "string") {
          const addressed = parseRunKey(request.agent.id);
          if (addressed?.host === agentHost.key) {
            const stream = await agentHost.events(addressed.runId, Math.max(0, Number(request.agent.after ?? 0) || 0));
            if (stream.run) response.agent = {
              run: stream.run,
              events: stream.events,
              liveText: textUpdate(`agent:${request.agent.id}:text`, request.agent.liveTextHash, stream.liveText),
              liveThinking: textUpdate(`agent:${request.agent.id}:thinking`, request.agent.liveThinkingHash, stream.liveThinking),
            };
          }
        }
        return compressedJson(req, response);
      } catch (cause: any) { return error(cause?.message ?? "Could not synchronize", 400); }
    }
    if (API.sessions.match(req.method, url.pathname)) {
      return json(supervisorState());
    }
    if (API.archivedSessions.match(req.method, url.pathname)) {
      const offset = Math.max(0, Math.floor(Number(url.searchParams.get("offset") ?? 0) || 0));
      const requested = Math.floor(Number(url.searchParams.get("limit") ?? ARCHIVED_PAGE_SIZE) || ARCHIVED_PAGE_SIZE);
      const limit = Math.min(ARCHIVED_MAX_PAGE_SIZE, Math.max(1, requested));
      const total = archivedCount();
      const sessions = publicSessions(archivedPage(offset, limit));
      return json({ sessions, total, offset, limit, hasMore: offset + sessions.length < total });
    }
    if (API.reorderSessions.match(req.method, url.pathname)) {
      try {
        const body = await readBody(req);
        const requested: string[] | null = Array.isArray(body.sessionIds)
          ? body.sessionIds.map((id: unknown) => String(id))
          : null;
        if (!requested || new Set(requested).size !== requested.length) return error("Complete unique sessionIds required");
        const current = activeSessionRows.all() as any[];
        const currentIds = new Set(current.map((row) => String(row.id)));
        if (requested.length !== currentIds.size || requested.some((id) => !currentIds.has(id)))
          return error("Thread list changed; refresh before reordering", 409);
        if (!ownsSupervisorLease()) return error("Supervisor instance was replaced", 503);
        db.transaction(() => {
          const update = db.query("UPDATE sessions SET display_order=? WHERE id=? AND archived_at IS NULL");
          requested.forEach((id, index) => update.run(index, id));
        })();
        signalSync();
        return json({ ok: true, sessions: publicSessions(activeSessionRows.all() as any[]) });
      } catch (cause: any) { return error(cause?.message ?? "Could not reorder threads", 400); }
    }
    if (API.createSession.match(req.method, url.pathname)) {
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
        };
        const workspaceId = destination.workspaceId;
        const name = nextThreadName();
        const requestedId = body.sessionId == null ? crypto.randomUUID() : String(body.sessionId);
        if (!/^[0-9a-f-]{36}$/i.test(requestedId)) return error("Valid sessionId required");
        const id = requestedId;
        const time = now();
        db.transaction(() => {
          db.query("UPDATE sessions SET display_order=display_order+1 WHERE archived_at IS NULL").run();
          db.query(`
            INSERT INTO sessions(
              id,name,workspace_id,session_path,state,created_at,updated_at,last_error,
              initial_provider,current_provider,initial_model,initial_thinking,profile_id,service_tier,display_order
            ) VALUES(?,?,?,?,?,?,?,NULL,?,?,?,?,?,?,0)
          `).run(id, name, workspaceId, null, "STOPPED", time, time,
            preset.provider, preset.provider, preset.modelId, preset.thinkingLevel, destination.id,
            model.id === "astra" ? "priority" : "default");
        })();
        const response = { session: publicSession(sessionRow.get(id)) };
        saveRequest(requestId, id, "create", 201, response);
        activate(sessionRow.get(id)).catch((e) => {
          const latest = sessionRow.get(id) as any;
          if (latest && !["STOPPED", "IDLE"].includes(String(latest.state))) setState(id, "FAILED", String(e.message ?? e));
        });
        return json(response, 201);
      } catch (e: any) { return error(e.message ?? "Invalid request"); }
    }
    const queuedItemMatch = API.queueItem.match(req.method, url.pathname);
    if (queuedItemMatch) {
      const { sessionId, workId } = queuedItemMatch;
      const row = sessionRow.get(sessionId) as any;
      if (!row) return error("Session not found", 404);
      let found = false;
      // Assigned inside the transaction callback, which TypeScript cannot see.
      let cancelled = null as { text: string } | null;
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
    const hardSteerMatch = API.queueHardSteer.match(req.method, url.pathname);
    if (hardSteerMatch) {
      const { sessionId, workId } = hardSteerMatch;
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
      const canHardSteer = earlierWork > 0 || !!rt && ["STARTING", "DISPATCHING", "RUNNING"].includes(rt.phase);
      if (!canHardSteer) return error("The agent has already finished; this message will start normally", 409);
      db.query("UPDATE work_items SET delivery='hardSteer',updated_at=? WHERE id=? AND state='queued'").run(now(), workId);
      touchSession(sessionId);
      const aborted = await hardSteerCurrentOperation(sessionId, workId);
      if (!aborted.ok) {
        const reverted = db.query("UPDATE work_items SET delivery='followUp',updated_at=? WHERE id=? AND state='queued' AND delivery='hardSteer'")
          .run(now(), workId);
        if (reverted.changes > 0) touchSession(sessionId);
        return error(aborted.error, aborted.status);
      }
      kickSession(sessionId);
      return json({ ...aborted, hardSteer: true, workId, delivery: "hardSteer", session: publicSession(sessionRow.get(sessionId)) });
    }
    const queueMatch = API.queueSteer.match(req.method, url.pathname);
    if (queueMatch) {
      const { sessionId, workId } = queueMatch;
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
    const sessionRoutes: Array<[string | undefined, (typeof API)[keyof typeof API]]> = [
      [undefined, API.session], [undefined, API.archiveSession], [undefined, API.rejectSessionEdit],
      ["unarchive", API.unarchiveSession], ["prompt", API.sessionPrompt], ["fork", API.sessionFork], ["abort", API.sessionAbort],
      ["events", API.sessionEvents], ["context", API.sessionContext], ["context", API.patchSessionContext],
      ["context", API.replaceSessionContext], ["settings", API.sessionSettings], ["settings", API.updateSessionSettings],
      ["commands", API.sessionCommands], ["command", API.sessionCommand],
    ];
    const sessionMatch = sessionRoutes.map(([action, route]) => ({ action, params: route.match(req.method, url.pathname) }))
      .find((candidate) => candidate.params !== null);
    if (!sessionMatch?.params) return error("Not found", 404);
    const id = sessionMatch.params.sessionId;
    const action = sessionMatch.action;
    const row = sessionRow.get(id) as any;
    if (!row) return error("Session not found", 404);
    if (!action && req.method === "GET") return json({ session: publicSession(row) });
    if (action === "unarchive" && req.method === "POST") {
      if (!row.archived_at) return json({ ok: true, session: publicSession(row) });
      const changedAt = now();
      db.transaction(() => {
        db.query("UPDATE sessions SET display_order=display_order+1 WHERE archived_at IS NULL").run();
        db.query("UPDATE sessions SET archived_at=NULL,display_order=0,state='STOPPED',last_error=NULL,updated_at=?,revision=revision+1 WHERE id=?")
          .run(changedAt, id);
      })();
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
      if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { ...API_CORS_HEADERS, etag, "cache-control": "no-cache" } });
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
        if (capturedAt <= current.capturedAt || current.hash === splice.targetHash) {
          if (current.hash === splice.targetHash) acknowledgeMessageContext(id, body.finalizesMessage);
          return json({ ok: true, capturedAt: current.capturedAt, hash: current.hash });
        }
        const appended = appendContextPatch(db, id, current, capturedAt, splice);
        if (!appended.ok) return error(appended.error, 409);
        cacheStoredContext(id, appended.value);
        acknowledgeMessageContext(id, body.finalizesMessage);
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
        const runtime = runtimes.get(id);
        const compactionReplacement = body.replacement === "compaction" && runtime?.compacting === true;
        let changed = false;
        let acknowledgedHash = sha256(document);
        let acknowledgedCapturedAt = capturedAt;
        db.transaction(() => {
          const current = storedContext(id);
          if (current && capturedAt <= current.capturedAt) {
            if (!compactionReplacement) {
              acknowledgedHash = current.hash;
              acknowledgedCapturedAt = current.capturedAt;
              return;
            }
            acknowledgedCapturedAt = current.capturedAt + 1;
          }
          db.query(`
            INSERT INTO session_contexts(session_id,captured_at,context) VALUES(?,?,?)
            ON CONFLICT(session_id) DO UPDATE SET captured_at=excluded.captured_at,context=excluded.context
          `).run(id, acknowledgedCapturedAt, document);
          db.query("DELETE FROM session_context_patches WHERE session_id=?").run(id);
          changed = true;
        })();
        if (changed) {
          cacheStoredContext(id, { capturedAt: acknowledgedCapturedAt, document, hash: acknowledgedHash });
          if (compactionReplacement && runtime) runtime.compactionContextHash = acknowledgedHash;
          if (acknowledgedHash === sha256(document)) acknowledgeMessageContext(id, body.finalizesMessage);
          signalSync();
        } else if (acknowledgedHash === sha256(document)) {
          acknowledgeMessageContext(id, body.finalizesMessage);
        }
        return json({ ok: true, capturedAt: acknowledgedCapturedAt, hash: acknowledgedHash });
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
        if (body.bashTimeoutSeconds != null) {
          const timeout = Number(body.bashTimeoutSeconds);
          if (!BASH_TIMEOUT_OPTIONS.some((option) => option === timeout)) {
            return error(`bashTimeoutSeconds must be one of ${BASH_TIMEOUT_OPTIONS.join(", ")}`);
          }
          const current = sessionRow.get(id) as any;
          if (bashTimeoutSeconds(current?.bash_timeout_seconds) !== timeout) {
            db.query("UPDATE sessions SET bash_timeout_seconds=?,updated_at=?,revision=revision+1 WHERE id=?")
              .run(timeout, now(), id);
            rt.expectedExit = true;
            rt.suppressOutput = true;
            setRuntimePhase(id, rt, "STOPPING");
            await terminateRuntimeProcess(rt);
            if (runtimes.get(id) === rt) return error("Could not restart the thread with its new bash timeout", 500);
            await activate(sessionRow.get(id));
          }
        }
        return json({ settings: await threadSettings(sessionRow.get(id)) });
      } catch (e: any) { return error(e.message ?? "Could not update thread settings", 500); }
    }
    if (action === "fork" && req.method === "POST") {
      try {
        const body = await readBody(req);
        const requestId = String(body.requestId ?? "");
        const previous = requestResult(requestId);
        if (previous) return json(JSON.parse(previous.response), previous.status);
        if (!/^[0-9a-f-]{36}$/i.test(requestId)) return error("Valid requestId required");
        const messageTimestamp = Number(body.messageTimestamp);
        if (!Number.isSafeInteger(messageTimestamp) || messageTimestamp <= 0) return error("Valid message timestamp required");
        if (forkingSessions.has(id)) return error("The conversation is already being edited", 409);
        forkingSessions.add(id);
        try {
          const rt = await activate(row);
          if (!ownsSupervisorLease()) return error("Supervisor instance was replaced", 503);
          const pendingWork = Number((db.query(
            "SELECT COUNT(*) AS count FROM work_items WHERE session_id=? AND state IN ('queued','running','dispatched')",
          ).get(id) as any)?.count ?? 0);
          if (rt.phase !== "IDLE" || pendingWork > 0) return error("Wait for the thread to become idle before editing an earlier message", 409);
          const before = await rpc(rt, "get_entries", {}, 10_000) as any;
          const branch = activeSessionEntries(Array.isArray(before.entries) ? before.entries : [], before.leafId);
          const selected = branch.findLast((entry) => entry?.type === "message"
            && entry.message?.role === "user"
            && Number(entry.message.timestamp) === messageTimestamp);
          if (!selected) return error("That user message is no longer on the active conversation branch", 409);
          const forked = await rpc(rt, "fork", { entryId: selected.id }, 30_000) as any;
          if (!ownsSupervisorLease()) return error("Supervisor instance was replaced", 503);
          if (forked.cancelled) return error("Editing from that message was cancelled", 409);
          const after = await rpc(rt, "get_entries", {}, 10_000) as any;
          if (!ownsSupervisorLease()) return error("Supervisor instance was replaced", 503);
          replaceConversationEvents(id, activeSessionEntries(Array.isArray(after.entries) ? after.entries : [], after.leafId));
          const runtimeState = await rpc(rt, "get_state", {}, 10_000) as any;
          const changedAt = now();
          db.query("UPDATE sessions SET session_path=?,state='IDLE',last_error=NULL,updated_at=?,revision=revision+1 WHERE id=?")
            .run(runtimeState.sessionFile ? String(runtimeState.sessionFile) : row.session_path, changedAt, id);
          rt.liveText = "";
          rt.liveThinking = "";
          rt.thinkingBlockStart = 0;
          rt.pendingContextTextLength = 0;
          rt.pendingContextThinkingLength = 0;
          rt.pendingContextFinalization = null;
          rt.activeTools.clear();
          rt.phaseVersion++;
          signalSync();
          const response = {
            ok: true,
            text: typeof forked.text === "string" ? forked.text : contentText(selected.message.content),
            session: publicSession(sessionRow.get(id)),
          };
          saveRequest(requestId, id, "fork", 200, response);
          return json(response);
        } finally {
          forkingSessions.delete(id);
          kickSession(id);
          if (releaseHandoffRequested) queueMicrotask(() => void handoffRelease());
        }
      } catch (e: any) { return error(e.message ?? "Could not edit from that message", 400); }
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
        if (forkingSessions.has(id)) return error("Wait for the conversation edit to finish", 409);
        const rt = runtimes.get(id);
        if (rt && ["ABORTING", "STOPPING"].includes(rt.phase)) return error("Thread is stopping; wait for it to become resumable", 409);
        const delivery = body.delivery === "steer" ? "steer" : body.delivery == null || body.delivery === "followUp" ? "followUp" : null;
        if (!delivery) return error("delivery must be steer or followUp");
        return json(enqueuePrompt(id, requestId, text, delivery), 202);
      } catch (e: any) { return error(e.message ?? "Prompt failed", 400); }
    }
    if (action === "abort" && req.method === "POST") {
      const aborted = await abortCurrentOperation(id);
      if (!aborted.ok) return error(aborted.error, aborted.status);
      return json({ ...aborted, session: publicSession(sessionRow.get(id)) });
    }
    return error("Not found", 404);
  },
});
console.log(`Pi Remote listening on http://${server.hostname}:${server.port}`);

// A rejected promise anywhere, such as an un-awaited get_state timeout under
// load, is isolated to its request. Crashing the supervisor hands recovery to
// systemd instead of turning one request failure into duplicated agent work.
process.on("unhandledRejection", (cause) => {
  console.error("Unhandled rejection (contained)", cause);
});
process.on("uncaughtException", (cause) => {
  console.error("Uncaught exception (contained)", cause);
});

refreshPlanUsageIfDue();
void agentHost.refresh();
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

const stopLedgerSnapshots = startLedgerSnapshots(
  join(DATA, "supervisor.sqlite3"), join(DATA, "backup", "supervisor.sqlite3"),
  (error) => console.error(`[supervisor] ledger snapshot failed: ${error}`),
);

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

function handoffDocument() {
  const runtimeSnapshots: RuntimeHandoff[] = [...runtimes].flatMap(([sessionId, rt]) => {
    if (!rt.transport?.pid || rt.phase === "STOPPING") return [];
    return [{
      sessionId,
      socketPath: rt.transport.socketPath,
      pid: rt.transport.pid,
      phase: rt.phase,
      compacting: rt.compacting,
      compactionContextHash: rt.compactionContextHash,
      retrying: rt.retrying,
      liveText: rt.liveText,
      liveThinking: rt.liveThinking,
      thinkingBlockStart: rt.thinkingBlockStart,
      pendingContextTextLength: rt.pendingContextTextLength,
      pendingContextThinkingLength: rt.pendingContextThinkingLength,
      pendingContextFinalization: rt.pendingContextFinalization,
      pendingModelFailure: rt.pendingModelFailure,
      lastActivity: rt.lastActivity,
      activeTools: [...rt.activeTools],
      dispatchedWorkIds: [...rt.dispatchedWorkIds],
      steeringQueued: rt.steeringQueued,
      followUpQueued: rt.followUpQueued,
      historyNeedsRestore: rt.historyNeedsRestore,
      modelId: rt.modelId,
    }];
  });
  return { version: 1, createdAt: now(), runtimes: runtimeSnapshots };
}

function stopSupervisorTimers() {
  clearInterval(reaper);
  clearInterval(stateReconciler);
  clearInterval(dashboardTicker);
  stopLedgerSnapshots();
  for (const timer of retryTimers.values()) clearTimeout(timer);
  retryTimers.clear();
}

async function handoffRelease() {
  if (shuttingDown) return;
  releaseHandoffRequested = true;
  await runtimeAdoption;
  if ([...runtimes.values()].some((runtime) => runtime.phase === "ABORTING") || forkingSessions.size > 0) {
    console.log("Pi Remote release handoff waiting for an in-flight session operation to resolve");
    return;
  }
  shuttingDown = true;
  stopSupervisorTimers();
  const staging = `${HANDOFF_PATH}.writing`;
  writeFileSync(staging, `${JSON.stringify(handoffDocument())}\n`, { mode: 0o600 });
  renameSync(staging, HANDOFF_PATH);
  for (const rt of runtimes.values()) rt.transport.detach();
  server.stop(true);
  agentHost.close();
  db.close();
  console.log("Pi Remote supervisor handed active runtimes to the selected release");
  process.exit(75);
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  stopSupervisorTimers();
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
  agentHost.close();
  db.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGUSR2", handoffRelease);
process.on("SIGHUP", handoffRelease);
