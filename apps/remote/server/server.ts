import { Database } from "bun:sqlite";
import type { ImageContent } from "@earendil-works/pi-ai";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { configuredFleetThreadUrl } from "./thread-owners";
import { projectThreadNotifications } from "./thread-notifications";
import { modelBrokerUrl, createWorkspaceAdmission, ORCHESTRATOR_CATALOG, OrchestratorClient, CompletionClient, type CompletionInput, catalogAgentType, createSharedImageGenerationService, ThreadService, ThreadDirectory, createThreadClient, importRemoteThreads, createSharedPiSessionOpener, threadHttp, type ThreadInspection, type Thread, type ThreadMessage, type PiEvent, type Result, type SharedImageGenerationService, type PlanUsageSnapshot } from "pi-orchestrator/api";
import { createLiveProjection, settleLiveProjection, restoreLiveProjection, threadActivity, type LiveProjection } from "./live-projection";
import { InlineImages } from "./inline-images";
import { planCards } from "./catalog-presentation";
import { readMachineUsage } from "./machine-usage";
import { displayContextDocument, type ContextImage } from "./context-display";
import { updateToolProgress, type ToolProgress } from "./tool-progress";
import { contextSplice, DocumentHistory, messageFinalizationKey, sha256, type ContextSplice } from "./sync";
import { appendContextPatch, readContext } from "./context-journal";
import { beginSupervisorGeneration, ensureSupervisorSchema, ensureThreadView } from "./database";
import { startLedgerSnapshots } from "./ledger-snapshot";
import { autoArchiveDelay, startAutoArchive } from "./auto-archive";
import { VoiceClient } from "./voice/client";
import { MeetServer } from "./meet/server";
import { meetingActivity } from "./meet/activity";
import { meetingHandoffText, prepareMeetingHandoff } from "./meet/handoff";
import { externalMeetingRequest } from "./meet/external";
import { liveDevInstructions } from "./skills";
import { defaultThreadDestinations, type ThreadDestination } from "./thread-model-defaults";
import { API } from "./api";
import { idleNotifications } from "./notifications";
import { listPersons, publicPerson } from "./persons";
import { ownEnvironment } from "./environments";
import { API_CORS_HEADERS } from "./cors";
import { fileBrowserError, listDirectory, localFileResponse, webResponse } from "./files";
import { governorControls, isGovernorProvider, toggleGovernor } from "./governors";
import { BASH_TIMEOUT_OPTIONS, DEFAULT_BASH_TIMEOUT_SECONDS, type AgentModelCount, type BashTimeoutSeconds, type Dashboard, type DocumentUpdate, type QueuedMessage, type Session, type SupervisorState, type SyncRequest, type SyncResponse } from "./protocol";
import { MachineActions } from "./machine-actions";
import { availableUploadPath, storeUpload, uploadName } from "./uploads";
import {
  generatedThreadName,
  shouldNameThread,
  THREAD_NAMING_HISTORY,
  THREAD_NAMING_INSTRUCTION,
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
const THREAD_NAMING_MODEL = process.env.PI_REMOTE_THREAD_NAMING_MODEL?.trim() || "luna";
const AUTO_ARCHIVE_AFTER_MS = autoArchiveDelay(process.env.PI_REMOTE_AUTO_ARCHIVE_AFTER_MS);
const PRIVATE_ID = process.env.PI_REMOTE_PRIVATE_ID ?? "private";
const PRIVATE_NAME = process.env.PI_REMOTE_PRIVATE_NAME ?? "Private";
const PRIVATE_DIR = process.env.PI_REMOTE_PRIVATE_DIR ?? join(HOME, PRIVATE_ID);
const THREAD_CONTEXT_EXTENSION = join(import.meta.dir, "thread-context.ts");
const ORCHESTRATOR_DB_PATH = process.env.PI_REMOTE_ORCHESTRATOR_DB ?? join(HOME, ".local/share/pi-orchestrator/ledger.sqlite3");
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

const THREAD_MODELS = new Map(ORCHESTRATOR_CATALOG.models.map((model) => [model.id, {
  id: model.id,
  label: model.label,
  icon: model.icon,
  accent: model.accent,
  provider: model.provider,
  modelId: model.model,
}]));
const OFFERED_DESTINATIONS = (process.env.PI_REMOTE_DESTINATIONS ?? "home").split(",").map((id) => id.trim()).filter(Boolean);
const destinationDefinitions: ThreadDestination[] = process.env.PI_REMOTE_THREAD_DESTINATIONS === undefined
  ? defaultThreadDestinations()
  : JSON.parse(process.env.PI_REMOTE_THREAD_DESTINATIONS);
const THREAD_DESTINATIONS = new Map(destinationDefinitions
  .filter((destination) => OFFERED_DESTINATIONS.includes(destination.id))
  .map((destination) => [destination.id, destination]));

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
const workspaceDefinitions = JSON.parse(process.env.PI_REMOTE_WORKSPACES ?? JSON.stringify([
  { id: "home", name: "Home", path: HOME },
  { id: PRIVATE_ID, name: PRIVATE_NAME, path: PRIVATE_DIR },
])) as Array<{ id: string; name: string; path: string }>;
const configuredWorkspaceAdmission = createWorkspaceAdmission(workspaceDefinitions);
if (!configuredWorkspaceAdmission.ok) throw new Error(configuredWorkspaceAdmission.error.message);
const workspaceAdmission = configuredWorkspaceAdmission.value;
const workspaces = workspaceAdmission.workspaces;
for (const destination of THREAD_DESTINATIONS.values()) {
  const admitted = workspaceAdmission.resolve(destination.workspaceId);
  if (!admitted.ok) throw new Error(`Thread profile ${destination.id}: ${admitted.error.message}`);
}

mkdirSync(DATA, { recursive: true, mode: 0o700 });
mkdirSync(INGESTION, { recursive: true, mode: 0o700 });
const db = new Database(join(DATA, "supervisor.sqlite3"), { create: true, strict: true });
const orchestrator = new OrchestratorClient({
  ledgerPath: ORCHESTRATOR_DB_PATH,
});
const voice = new VoiceClient(DATA);
const liveProjections = new Map<string, LiveProjection>();
const contextFinalizedMessages = new Map<string, string>();
const forkingSessions = new Set<string>();
let shuttingDown = false;
const runner = createSharedPiSessionOpener({ dataDir: DATA });
const threads = new ThreadService({
  databasePath: join(DATA, "threads.sqlite3"),
  sessionsDir: join(DATA, "threads"),
  openSession: (options, output, exit) => runner.openSession({ ...options,
    args: [...options.args, "--extension", THREAD_CONTEXT_EXTENSION],
  }, output, exit),
  environment: threadEnvironment,
  prepareMessage: prepareThreadMessage,
});
unwrap(importRemoteThreads(threads, db as any, { sessionsDir: join(DATA, "threads"),
  resolveCwd: workspace => workspaces.get(workspace)?.path ?? workspace }));
ensureSupervisorSchema(db);
beginSupervisorGeneration(db, SUPERVISOR_EPOCH);
const fleetUrl = configuredFleetThreadUrl();
const fleet = fleetUrl ? createThreadClient(`${fleetUrl}/v1/thread-owner`) : null;
const namingUrl = modelBrokerUrl() ?? fleetUrl;
const namingClient = namingUrl ? new CompletionClient({ baseUrl: namingUrl }) : null;
const directory = new ThreadDirectory({ id: "person", api: threads }, fleet ? [{ id: "fleet", api: fleet }] : []);
threads.setDirectory(directory, (parent, input) => {
  // Encrypted-folder sessions must retain their mount namespace and transcript custody.
  const privatePath = (path: string) => resolve(path) === resolve(PRIVATE_DIR) || resolve(path).startsWith(`${resolve(PRIVATE_DIR)}/`);
  return privatePath(parent.cwd) || privatePath(input.cwd) ? undefined : fleet ?? undefined;
});
const peerThreads = new Map<string, Thread>();
const peerChildren = new Map<string, boolean>();
const peerInspections = new Map<string, ThreadInspection>();
let peerError: string | null = null;
const notificationErrors = new Map<string, string>();
let peerRefresh: Promise<void> | null = null;
const notificationRefreshes = new Map<string, Promise<void>>();
function refreshThreadNotifications(): Promise<void> {
  return Promise.all(directory.owners.map(owner => {
    const existing = notificationRefreshes.get(owner.id);
    if (existing) return existing;
    const before = currentStateVersion();
    const refresh = projectThreadNotifications(db, owner.id, owner.api)
      .then(() => { if (notificationErrors.delete(owner.id)) signalSync(); })
      .catch(cause => {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (notificationErrors.get(owner.id) !== message) { notificationErrors.set(owner.id, message); signalSync(); }
      })
      .finally(() => { notificationRefreshes.delete(owner.id); if (currentStateVersion() !== before) signalSync(); });
    notificationRefreshes.set(owner.id, refresh);
    return refresh;
  })).then(() => {});
}
async function refreshPeers() {
  if (!fleet) return;
  if (peerRefresh) return peerRefresh;
  peerRefresh = (async () => {
    const next = new Map<string, Thread>();
    let cursor: string | undefined;
    do {
      const page = await fleet.list({ limit: 100, cursor });
      if (!page.ok) { if (peerError !== page.error.message) { peerError = page.error.message; signalSync(); } return; }
      for (const thread of page.value.threads) {
        if (threads.get(thread.id)) throw new Error(`Thread ${thread.id} has two owners`);
        next.set(thread.id, thread);
      }
      cursor = page.value.nextCursor;
    } while (cursor);
    const changed = peerError !== null || JSON.stringify([...next]) !== JSON.stringify([...peerThreads]);
    peerError = null;
    peerThreads.clear();
    peerChildren.clear();
    for (const thread of next.values()) if (thread.parentId) peerChildren.set(thread.parentId, true);
    for (const [id, thread] of next) { peerThreads.set(id, thread); ensureThreadView(db, id); }
    if (changed) signalSync();
  })().catch(cause => {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (peerError !== message) { peerError = message; signalSync(); }
  }).finally(() => { peerRefresh = null; });
  return peerRefresh;
}
async function refreshThreadInspection(id: string) {
  const local = threads.get(id);
  if (local && !peerInspections.has(id) && storedContext(id)) return;
  const result = await directory.inspect(id);
  if (!result.ok) throw new Error(result.error.message);
  const inspection = result.value;
  if (!local) {
    const children = unwrap(await directory.list({ parentId: id, limit: 1 }));
    peerChildren.set(id, children.threads.length > 0);
  }
  const changed = !local && (peerThreads.get(id)?.revision !== inspection.thread.revision
    || JSON.stringify(peerInspections.get(id)?.pending) !== JSON.stringify(inspection.pending));
  if (!local) peerThreads.set(id, inspection.thread);
  peerInspections.delete(id);
  peerInspections.set(id, inspection);
  while (peerInspections.size > 12) peerInspections.delete(peerInspections.keys().next().value!);
  ensureThreadView(db, id);
  if (changed) signalSync();
  if (inspection.live) restoreLiveProjection(liveFor(id), inspection.live);
}
function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}
function liveFor(id: string): LiveProjection {
  let live = liveProjections.get(id);
  if (!live) { live = createLiveProjection(id); liveProjections.set(id, live); }
  return live;
}

const now = () => new Date().toISOString();
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
let imageProvider: SharedImageGenerationService | undefined;
const inlineImages = new InlineImages(db, join(DATA, "inline-images"), async (input, signal) => {
  try {
    imageProvider ??= createSharedImageGenerationService({ ledgerPath: ORCHESTRATOR_DB_PATH });
    return await imageProvider.generateImageWithSharedAccount(input, { signal });
  } catch (cause) {
    return { ok: false, error: { message: cause instanceof Error ? cause.message : String(cause) } };
  }
}, signalSync, 2, ownsSupervisorLease);
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
  void refreshPeers();
  const [agents, actions] = await Promise.all([activeAgents(), machineActions.refresh()]);
  return {
    plans: planCards(planUsage),
    governors: governorControls(orchestrator),
    actions,
    machine: readMachineUsage(),
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
    if (request.session?.eventsAfter !== undefined || !request.session) return after === syncSequence;
    const { id, contextHash, liveTextHash, liveThinkingHash } = request.session;
    const stored = storedContext(id);
    const runtime = liveProjections.get(id);
    return (stored ? displayContext(id, stored.hash, stored.document).hash === contextHash : !contextHash)
      && sha256(runtime?.liveText ?? "") === liveTextHash
      && sha256(runtime?.liveThinking ?? "") === liveThinkingHash
      && (request.session.imagesVersion === undefined || inlineImages.version(id) === request.session.imagesVersion);
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
  const progress = liveProjections.get(sessionId)?.toolProgress;
  if (progress?.size) {
    for (const message of JSON.parse(sourceDocument).messages ?? []) {
      if (message?.role === "toolResult") progress.delete(message.toolCallId);
    }
  }
  const images = new Map<string, ContextImage>();
  const document = displayContextDocument(sourceDocument, streamedThinkingByMessage(sessionId), (image) => {
    const hash = sha256(`${image.mimeType}\0${image.data}`);
    images.set(hash, image);
    return API.sessionImage.path({ sessionId, hash });
  }, liveProjections.get(sessionId)?.toolProgress.values());
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
  if (stored && threads.get(sessionId)) peerInspections.delete(sessionId);
  const progress = liveProjections.get(sessionId)?.toolProgress;
  if (progress?.size && stored && storedContextCache.get(sessionId)?.hash !== stored.hash) {
    for (const message of JSON.parse(stored.document).messages ?? []) {
      if (message?.role === "toolResult") progress.delete(message.toolCallId);
    }
  }
  storedContextCache.delete(sessionId);
  storedContextCache.set(sessionId, stored);
  while (storedContextCache.size > 4) storedContextCache.delete(storedContextCache.keys().next().value!);
}

function storedContext(sessionId: string): { capturedAt: number; document: string; hash: string } | null {
  const peer = peerInspections.get(sessionId);
  if (peer) {
    if (!peer.context) return null;
    const document = JSON.stringify(peer.context);
    return { capturedAt: peer.thread.updatedAt, document, hash: sha256(document) };
  }
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

function storeContextCapture(id: string, body: any) {
  const capturedAt = Number(body.capturedAt);
  const context = body.context;
  if (!Number.isSafeInteger(capturedAt) || capturedAt <= 0) throw new Error("Valid context capture time required");
  if (!context || typeof context !== "object" || typeof context.systemPrompt !== "string"
    || !Array.isArray(context.tools) || !Array.isArray(context.messages)) throw new Error("Valid context required");
  const document = JSON.stringify(context);
  const runtime = liveProjections.get(id);
  const compactionReplacement = body.replacement === "compaction" && runtime?.compacting === true;
  let changed = false;
  let hash = sha256(document);
  let time = capturedAt;
  db.transaction(() => {
    const current = storedContext(id);
    if (current && capturedAt <= current.capturedAt) {
      if (!compactionReplacement) { hash = current.hash; time = current.capturedAt; return; }
      time = current.capturedAt + 1;
    }
    db.query(`INSERT INTO session_contexts(session_id,captured_at,context) VALUES(?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET captured_at=excluded.captured_at,context=excluded.context`).run(id, time, document);
    db.query("DELETE FROM session_context_patches WHERE session_id=?").run(id);
    inlineImages.acceptContext(id, document);
    changed = true;
  })();
  if (changed) {
    cacheStoredContext(id, { capturedAt: time, document, hash });
    if (compactionReplacement && runtime) runtime.compactionContextHash = hash;
    signalSync();
  }
  if (hash === sha256(document)) acknowledgeMessageContext(id, body.finalizesMessage);
  return { ok: true, capturedAt: time, hash };
}

function requireCompactionContext(sessionId: string, rt: LiveProjection) {
  const stored = storedContext(sessionId);
  if (!rt.compactionContextHash || stored?.hash !== rt.compactionContextHash) clearStoredContext(sessionId);
  rt.compactionContextHash = null;
}

function acknowledgeMessageContext(sessionId: string, finalizesMessage: unknown) {
  if (typeof finalizesMessage !== "string" || !finalizesMessage) return;
  contextFinalizedMessages.set(sessionId, finalizesMessage);
  const rt = liveProjections.get(sessionId);
  if (!rt || rt.pendingContextFinalization !== finalizesMessage) return;
  rt.pendingContextFinalization = null;
  rt.liveText = rt.liveText.slice(Math.min(rt.pendingContextTextLength, rt.liveText.length));
  const removedThinkingLength = Math.min(rt.pendingContextThinkingLength, rt.liveThinking.length);
  rt.liveThinking = rt.liveThinking.slice(removedThinkingLength);
  rt.thinkingBlockStart = Math.max(0, rt.thinkingBlockStart - removedThinkingLength);
  rt.pendingContextTextLength = 0;
  rt.pendingContextThinkingLength = 0;
  signalLiveSync();
}

const error = (message: string, status = 400) => json({ error: message }, status);
function threadError(failure: { code: string; message: string }) {
  return json({ error: failure.message, code: failure.code }, failure.code === "not_found" ? 404
    : failure.code === "invalid_request" ? 400 : failure.code === "unavailable" ? 503 : 409);
}

async function sessionFileResponse(url: URL, method: string, req: Request): Promise<Response | null> {
  const match = API.sessionFiles.match(method, url.pathname) ?? API.sessionFilesHead.match(method, url.pathname);
  if (!match) return null;
  const row = sessionRow.get(match.sessionId) as any;
  if (!row) return new Response("Session not found", { status: 404, headers: API_CORS_HEADERS });
  return localFileResponse(url.searchParams.get("path") ?? "", method, req);
}

function meetingInstructions(sessionId: string): string {
  return (sessionRow.get(sessionId) as any)?.meeting_id ? liveDevInstructions() : "";
}

function threadInstructions(sessionId: string): string {
  const snapshot = inlineImages.snapshot(sessionId);
  const registry = snapshot.images.map(({ id, state, refs, path, paths, error, conflict }) => ({ id, state, refs, path, paths, error, conflict }));
  return [
    meetingInstructions(sessionId),
    registry.length ? `Pi Remote image registry: ${JSON.stringify({ version: snapshot.version, images: registry })}` : "",
  ].filter(Boolean).join("\n\n");
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
  const policy = readFileSync(new URL("./voice/delegation-policy.md", import.meta.url), "utf8").trim();
  return [
    policy,
    `Connected Pi thread: ${JSON.stringify({ id: row.id, name: row.name, meeting: Boolean(row.meeting_id) })}`,
    threadInstructions(row.id),
    history ? `Recent thread transcript:\n${history}` : "",
  ].filter(Boolean).join("\n\n");
}

function remotePlacement(thread: Thread): Record<string, unknown> {
  const seen = new Set<string>();
  const placement: Record<string, unknown> = {};
  let current: Thread | null = thread;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    for (const key of ["workspaceId", "profileId", "meetingId", "bashTimeoutSeconds"]) {
      if (!(key in placement) && current.metadata && key in current.metadata) placement[key] = current.metadata[key];
    }
    current = current.parentId ? threads.get(current.parentId) : null;
  }
  return placement;
}
function threadRow(thread: Thread): any {
  const meta = { ...remotePlacement(thread), ...thread.metadata };
  const view = db.query("SELECT * FROM thread_views WHERE id=?").get(thread.id) as any;
  const [provider, ...modelParts] = thread.settings.model.split("/");
  const model = { provider, modelId: modelParts.join("/") };
  return { ...thread, name: thread.title, workspace_id: meta.workspaceId ?? thread.cwd,
    session_path: thread.sessionFile, state: thread.state.toUpperCase(),
    initial_model: model?.modelId ?? thread.settings.model, current_provider: model?.provider ?? "",
    initial_provider: model?.provider ?? "", initial_thinking: thread.settings.thinkingLevel,
    meeting_id: meta.meetingId ?? null, profile_id: meta.profileId ?? "home",
    service_tier: thread.settings.speed === "priority" ? "priority" : "default",
    bash_timeout_seconds: meta.bashTimeoutSeconds ?? DEFAULT_BASH_TIMEOUT_SECONDS,
    archived_at: meta.archived ? meta.archivedAt ?? new Date(thread.updatedAt).toISOString() : null, display_order: view?.display_order ?? 0,
    idle_unread: view?.idle_unread ?? 0, named_at_message_count: view?.named_at_message_count ?? 0,
    last_error: meta.executionError ?? view?.naming_error ?? null,
    created_at: new Date(thread.createdAt).toISOString(), updated_at: new Date(thread.updatedAt).toISOString() };
}
const sessionRow = { get(id: string) { const found = threads.get(id) ?? peerThreads.get(id); return found ? threadRow(found) : null; } };
function allThreadRows() { return [...threads.snapshot(), ...peerThreads.values()].map(threadRow); }
const activeSessionRows = { all: () => allThreadRows().filter(row => !row.archived_at)
  .sort((a,b) => a.display_order - b.display_order || b.createdAt - a.createdAt) };
const ARCHIVED_PAGE_SIZE = 50;
const ARCHIVED_MAX_PAGE_SIZE = 100;
const archivedRows = () => allThreadRows().filter(row => row.archived_at)
  .sort((a,b) => String(b.archived_at).localeCompare(String(a.archived_at)));
const archivedPage = (offset: number, limit: number) => archivedRows().slice(offset, offset + limit);
const archivedCount = () => archivedRows().length;

const supervisorEpochRow = db.query("SELECT value FROM metadata WHERE key='supervisor_epoch'");
function ownsSupervisorLease(): boolean {
  try { return (supervisorEpochRow.get() as any)?.value === SUPERVISOR_EPOCH; }
  catch { return false; }
}

function emit(sessionId: string, type: string, payload: unknown = {}, receiptId: string | null = null): number {
  if (!ownsSupervisorLease()) return 0;
  ensureThreadView(db, sessionId);
  const result = db.query("INSERT OR IGNORE INTO events(session_id,time,type,payload,receipt_id) VALUES(?,?,?,?,?)")
    .run(sessionId, now(), type, JSON.stringify(payload), receiptId ? `${sessionId}:${receiptId}` : null);
  if (!result.changes) return 0;
  signalSync();
  return Number(result.lastInsertRowid);
}

function recordThinkingEvent(sessionId: string, text: string, finalizesMessage: string) {
  if (!ownsSupervisorLease() || !text) return;
  displayContexts.delete(sessionId);
  emit(sessionId, "thinking", { text, finalizesMessage }, `thinking:${finalizesMessage}`);
}

function touchSession(_id: string) { signalSync(); }
function markSessionViewed(id: string) {
  const result = db.query("UPDATE thread_views SET idle_unread=0 WHERE id=? AND idle_unread<>0").run(id);
  if (result.changes) signalSync();
}
function nextThreadName(): string {
  const current = Number((db.query("SELECT value FROM metadata WHERE key='last_thread_number'").get() as any)?.value ?? 0);
  db.query("INSERT OR REPLACE INTO metadata(key,value) VALUES('last_thread_number',?)").run(String(current + 1));
  return String(current + 1);
}

function creationName(requestId: string): string {
  return db.transaction(() => {
    const saved = db.query("SELECT title FROM thread_creation_names WHERE request_id=?").get(requestId) as { title: string } | null;
    if (saved) return saved.title;
    const title = nextThreadName();
    db.query("INSERT INTO thread_creation_names(request_id,title) VALUES(?,?)").run(requestId, title);
    return title;
  })();
}

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

type NamingReceipt = { requestId: string; messageCount: number; input: CompletionInput };
function namingInput(transcript: string): CompletionInput {
  const parts = THREAD_NAMING_MODEL.split(":");
  if (parts.length > 2) throw new Error("Invalid naming model selection");
  const physical = parts[0]!.split("/").at(-1)!;
  const model = ORCHESTRATOR_CATALOG.models.find(candidate => candidate.id === physical || candidate.model === physical);
  if (!model || !["luna", "terra"].includes(model.id)) throw new Error("Thread naming completion currently supports Luna or Terra");
  const thinkingLevel = parts[1];
  if (thinkingLevel && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinkingLevel)) throw new Error("Invalid naming thinking level");
  return { model: model.id as "luna" | "terra", systemPrompt: THREAD_NAMING_INSTRUCTION, prompt: transcript,
    speed: "standard", ...(thinkingLevel ? { thinkingLevel } : {}) } as CompletionInput;
}
function namingError(id: string, message: string | null) {
  const result = db.query("UPDATE thread_views SET naming_error=? WHERE id=? AND naming_error IS NOT ?").run(message, id, message);
  if (result.changes) signalSync();
}
async function nameThread(sessionId: string): Promise<void> {
  if (namingThreads.has(sessionId) || shuttingDown) return;
  namingThreads.add(sessionId);
  try {
    const row = sessionRow.get(sessionId);
    if (!row) return;
    ensureThreadView(db, sessionId);
    const view = db.query("SELECT * FROM thread_views WHERE id=?").get(sessionId) as any;
    const messageCount = Number((db.query("SELECT count(*) count FROM events WHERE session_id=? AND type IN ('user','assistant')").get(sessionId) as any).count);
    let receipt = view.naming_request ? JSON.parse(view.naming_request) as NamingReceipt : null;
    if (!receipt && (!shouldNameThread(row.name, messageCount, view.named_at_message_count) || messageCount <= view.naming_attempted_count)) return;
    if (!namingClient) {
      db.query("UPDATE thread_views SET naming_attempted_count=? WHERE id=?").run(messageCount, sessionId);
      namingError(sessionId, "Thread naming has no explicitly permitted same-person completion owner");
      return;
    }
    let submitted = false;
    if (!receipt) {
      db.query("UPDATE thread_views SET naming_attempted_count=? WHERE id=?").run(messageCount, sessionId);
      const input = namingInput(recentThreadTranscript(sessionId));
      receipt = { requestId: `remote-name:${sessionId}:${messageCount}`, messageCount, input };
      db.query("UPDATE thread_views SET naming_request=?,naming_attempted_count=? WHERE id=?")
        .run(JSON.stringify(receipt), messageCount, sessionId);
      submitted = true;
    }
    let result = submitted ? await namingClient.submit(receipt.requestId, receipt.input) : await namingClient.get(receipt.requestId);
    if (!result.ok && result.error.code === "not-found") result = await namingClient.submit(receipt.requestId, receipt.input);
    if (!ownsSupervisorLease() || shuttingDown) return;
    if (!result.ok) { namingError(sessionId, result.error.message); return; }
    if (result.value.state === "queued" || result.value.state === "running") { namingError(sessionId, null); return; }
    db.query("UPDATE thread_views SET naming_request=NULL WHERE id=?").run(sessionId);
    if (result.value.state !== "completed") {
      if ("error" in result.value) namingError(sessionId, result.value.error.message);
      return;
    }
    const title = generatedThreadName(result.value.result.text);
    unwrap(threads.update(sessionId, { title }));
    db.query("UPDATE thread_views SET named_at_message_count=?,naming_error=NULL WHERE id=?").run(receipt.messageCount, sessionId);
    signalSync();
  } catch (cause) {
    if (ownsSupervisorLease()) namingError(sessionId, cause instanceof Error ? cause.message : String(cause));
  } finally { namingThreads.delete(sessionId); }
}
function scheduleThreadNameIfDue(sessionId: string) { void nameThread(sessionId); }
function reconcileThreadNames() {
  for (const row of db.query("SELECT id FROM thread_views WHERE naming_request IS NOT NULL").all() as {id: string}[]) void nameThread(row.id);
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
  const models = new Map<string, AgentModelCount>();
  let running = 0;
  for (const row of allThreadRows()) if (["STARTING", "RUNNING"].includes(row.state)) {
    running++; addAgentModel(models, row.settings.model);
  }
  return { running, models: sortedAgentModels(models) };
}

function supervisorState(): SupervisorState {
  return {
    sessions: publicSessions(activeSessionRows.all() as any[]),
    archived: publicSessions(archivedPage(0, ARCHIVED_PAGE_SIZE)),
    archivedTotal: archivedCount(),
    ownerErrors: [...(peerError ? [{ owner: "fleet", message: peerError }] : []),
      ...[...notificationErrors].map(([owner, message]) => ({ owner, message })),
      ...(db.query("SELECT id,naming_error FROM thread_views WHERE naming_error IS NOT NULL").all() as any[])
        .map(row => ({ owner: `Thread ${sessionRow.get(row.id)?.name ?? row.id} naming`, message: row.naming_error }))],
  };
}

function publicSessions(rows: any[]): Session[] {
  const parents = new Set(threads.snapshot().map(thread => thread.parentId));
  return rows.map(row => publicSession(row, parents.has(row.id) || Boolean(peerChildren.get(row.id))));
}
function sessionActivity(row: any): Session["activity"] {
  return threadActivity(row.state, liveProjections.get(row.id));
}
function publicSession(row: any, hasChildren = threads.snapshot().some(thread => thread.parentId === row.id) || Boolean(peerChildren.get(row.id))): Session {
  const pending = threads.get(row.id) ? threads.pending(row.id) : peerInspections.get(row.id)?.pending ?? [];
  const live = liveProjections.get(row.id);
  const queuedMessages: QueuedMessage[] = pending.filter(message => !message.insertedAt).map(message => ({
    id: message.id, text: message.text, delivery: message.delivery, state: message.state ?? "queued",
    status: message.state === "held" ? "Held until resumed" : message.state === "dispatched" ? "Sent to agent"
      : message.delivery === "steer" ? "Steering after current tool calls" : "Queued for after completion",
    canSteer: ["queued", "held"].includes(message.state ?? "queued") && message.delivery === "queue",
    canHardSteer: ["queued", "held"].includes(message.state ?? "queued"),
    canCancel: ["queued", "held"].includes(message.state ?? "queued"),
    createdAt: new Date(message.createdAt).toISOString(), lastError: null,
  }));
  return {
    id: row.id, parentId: row.parentId,
    hasChildren,
    origin: threads.get(row.id) ? "person" : "fleet",
    model: row.settings.model, name: row.name, cwd: row.cwd,
    workspaceName: workspaces.get(row.workspace_id)?.name ?? row.cwd,
    environment: ENVIRONMENT_ID, state: row.state, activity: sessionActivity(row),
    activeTool: [...(live?.activeTools.values() ?? [])].at(-1) ?? null,
    provider: String(row.current_provider).startsWith("anthropic") ? "anthropic" : "openai",
    createdAt: row.created_at, updatedAt: row.updated_at, revision: row.revision,
    idleUnread: Boolean(row.idle_unread), lastError: row.last_error ?? null,
    steeringQueued: pending.filter(message => message.delivery === "steer").length,
    followUpQueued: pending.filter(message => message.delivery === "queue").length,
    queuedMessages, archivedAt: row.archived_at,
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

async function rpc(id: string, type: string, body: Record<string, unknown> = {}): Promise<any> {
  return unwrap(await directory.command(id, { type, ...body }));
}

function handlePiEvent(sessionId: string, event: any) {
  if (!ownsSupervisorLease()) return;
  ensureThreadView(db, sessionId);
  const rt = liveFor(sessionId);
  if (event.type === "response" && event.command === "get_state" && event.success && event.data?.live) {
    restoreLiveProjection(rt, event.data.live);
    displayContexts.delete(sessionId);
    signalLiveSync();
    return;
  }
  if (event.type === "thread_error") {
    emit(sessionId, "notice", { text: String(event.error) });
    return;
  }
  if (event.type === "context_update") {
    const last = event.context?.messages?.findLast((message: any) => message.role === "assistant");
    storeContextCapture(sessionId, { context: event.context,
      capturedAt: Math.max(Date.now(), (storedContext(sessionId)?.capturedAt ?? 0) + 1),
      replacement: rt.compacting ? "compaction" : undefined,
      finalizesMessage: event.finalizesMessage ?? messageFinalizationKey(last) });
    return;
  }
  if (event.type === "thread_message_inserted") {
    const annotation = db.query("SELECT meeting_transcript FROM message_annotations WHERE work_id=?").get(event.workId) as { meeting_transcript: string } | null;
    const handoff = annotation ? meetingHandoffText(JSON.parse(annotation.meeting_transcript)) : "";
    emit(sessionId, "user", { text: [event.message.text, handoff].filter(Boolean).join("\n\n"),
      delivery: event.message.delivery, workId: event.workId }, `inserted:${event.workId}`);
    scheduleThreadNameIfDue(sessionId);
    return;
  }
  if (event.type === "thread_settled") {
    settleLiveProjection(rt);
    void refreshThreadNotifications();
    emit(sessionId, "settled", { workId: event.workId, outcome: event.outcome }, `settled:${event.executionId}`);
    if (event.outcome === "failed") emit(sessionId, "notice", {
      text: modelFailureText(event.finalMessage) ?? "The thread execution failed",
    }, `failure:${event.executionId}`);
    return;
  }

  if (event.type === "agent_start") {
    rt.thinkingActive = false;
  } else if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
    if (rt.thinkingActive) { rt.thinkingActive = false; touchSession(sessionId); }
    rt.liveText += event.assistantMessageEvent.delta ?? "";
    signalLiveSync();
  } else if (event.type === "message_update" && event.assistantMessageEvent?.type === "thinking_start") {
    // A provider can open several thinking content blocks in one assistant
    // message. Keep their deltas together until message_end identifies the
    // durable message that owns them.
    rt.thinkingBlockStart = rt.liveThinking.length;
    rt.thinkingActive = true;
    touchSession(sessionId);
  } else if (event.type === "message_update" && event.assistantMessageEvent?.type === "thinking_delta") {
    if (!rt.thinkingActive) { rt.thinkingActive = true; touchSession(sessionId); }
    rt.liveThinking += event.assistantMessageEvent.delta ?? "";
    signalLiveSync();
  } else if (event.type === "message_update" && event.assistantMessageEvent?.type === "thinking_end") {
    rt.thinkingActive = false;
    const block = String(event.assistantMessageEvent.content ?? "");
    if (block && rt.liveThinking.length === rt.thinkingBlockStart) rt.liveThinking += block;
    touchSession(sessionId);
  } else if (event.type === "message_end") {
    if (rt.thinkingActive) { rt.thinkingActive = false; touchSession(sessionId); }
    const text = textFromMessage(event.message);
    if (event.message?.role === "assistant") {
      inlineImages.accept(sessionId, sha256(text), text);
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
    if (text && event.message?.role === "assistant") {
      emit(sessionId, "assistant", { text }, `assistant:${messageFinalizationKey(event.message)}`);
      scheduleThreadNameIfDue(sessionId);
    }
  } else if (event.type === "tool_execution_start") {
    const toolCallId = String(event.toolCallId ?? crypto.randomUUID());
    const name = String(event.toolName ?? "tool");
    rt.thinkingActive = false;
    rt.activeTools.set(toolCallId, name);
    const args = boundedJson(event.args);
    rt.toolProgress.set(toolCallId, { id: toolCallId, name, args, startedAt: Date.now(), output: "" });
    displayContexts.delete(sessionId);
    touchSession(sessionId);
    emit(sessionId, "tool_start", { toolCallId, name, args });
  } else if (event.type === "tool_execution_update") {
    const toolCallId = String(event.toolCallId ?? "");
    let tool = rt.toolProgress.get(toolCallId);
    if (!tool) {
      const name = String(event.toolName ?? "tool");
      tool = { id: toolCallId, name, args: undefined, startedAt: Date.now(), observedStart: true, output: "" };
      rt.activeTools.set(toolCallId, name);
      touchSession(sessionId);
    }
    rt.toolProgress.set(toolCallId, updateToolProgress(tool, toolResultText(event.partialResult)));
    displayContexts.delete(sessionId);
    signalLiveSync();
  } else if (event.type === "tool_execution_end") {
    const toolCallId = String(event.toolCallId ?? "");
    rt.activeTools.delete(toolCallId);
    const output = toolResultText(event.result);
    const tool = rt.toolProgress.get(toolCallId);
    if (tool) rt.toolProgress.set(toolCallId, { ...tool, result: {
      content: [{ type: "text", text: output }], timestamp: Date.now(), isError: Boolean(event.isError),
    } });
    displayContexts.delete(sessionId);
    touchSession(sessionId);
    emit(sessionId, "tool_end", {
      toolCallId,
      name: String(event.toolName ?? "tool"),
      output,
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
    else {
      rt.compactionContextHash = null;
    }
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
      void rpc(sessionId, "extension_ui_response", { id: event.id, cancelled: true }).catch(cause => console.error(cause));
      emit(sessionId, "notice", { text: "An interactive extension dialog was cancelled on mobile." });
    }
  }
}

function threadEnvironment(thread: Thread) {
  const meta = remotePlacement(thread);
  return { ...process.env, HOME,
    PI_REMOTE_WORKSPACES: JSON.stringify([...workspaces.values()]),
    PI_REMOTE_SESSION_ID: thread.id, PI_THREAD_API_URL: `http://${HOST}:${PORT}/v1/threads`,
    PI_THREAD_DATABASE: join(DATA, "threads.sqlite3"),
    PI_SESSION_ID: thread.id, PI_SESSION_FILE: thread.sessionFile,
    PI_REMOTE_MEETING_ID: String(meta.meetingId ?? ""), PI_REMOTE_CONTEXT_OWNER_PID: "",
    PI_REMOTE_BASH_TIMEOUT_MAX_SECONDS: String(bashTimeoutSeconds(meta.bashTimeoutSeconds)),
    PI_REMOTE_SERVER_URL: `http://${HOST}:${PORT}`, PI_CODING_AGENT_DIR: AGENT_DIR,
  };
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
  const commands = await rpc(row.id, "get_commands");
  return { commands: commands.commands ?? [] };
}
async function runCommand(row: any, requestId: string, name: string, args: string) {
  const previous = requestResult(requestId);
  if (previous) return { response: JSON.parse(previous.response), status: previous.status };
  const response = name === "compact"
    ? await rpc(row.id, "compact", { id: requestId, customInstructions: args || undefined })
    : await enqueuePrompt(row.id, requestId, `/${name}${args ? ` ${args}` : ""}`, "queue");
  saveRequest(requestId, row.id, "command", 202, response);
  return { response, status: 202 };
}
async function directChildren(id: string): Promise<Result<Session[]>> {
  const owner = await directory.owner(id);
  if (!owner.ok) return owner;
  const children: Thread[] = [];
  let cursor: string | undefined;
  do {
    const page = await directory.list({ parentId: id, limit: 100, cursor });
    if (!page.ok) return page;
    children.push(...page.value.threads);
    cursor = page.value.nextCursor;
  } while (cursor);
  for (const thread of children) if (!threads.get(thread.id)) { peerThreads.set(thread.id, thread); ensureThreadView(db, thread.id); }
  if (!threads.get(id)) peerChildren.set(id, children.length > 0);
  return { ok: true, value: publicSessions(children.map(threadRow)) };
}

async function threadSettings(row: any) {
  const [state, availableModels, availableThinking, children] = await Promise.all([
    rpc(row.id, "get_state"), rpc(row.id, "get_available_models"), rpc(row.id, "get_available_thinking_levels"), directChildren(row.id),
  ]);
  return {
    children: unwrap(children),
    model: state.model,
    thinkingLevel: row.settings.thinkingLevel,
    speedMode: row.settings.speed,
    speedModes: String(state.model?.provider).startsWith("openai") ? ["standard", "priority"] : [],
    bashTimeoutSeconds: bashTimeoutSeconds(row.bash_timeout_seconds),
    models: rolledUpModels(availableModels.models ?? []), thinkingLevels: availableThinking.levels ?? [],
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

async function prepareThreadMessage(thread: Thread, message: ThreadMessage): Promise<Result<{text: string; images?: unknown[]}>> {
  const meetingId = remotePlacement(thread).meetingId;
  if (typeof meetingId !== "string" || !meetingId) return { ok: true, value: { text: message.text, images: message.images } };
  try {
    await meet.flushTranscript(meetingId);
    const transcript = await prepareMeetingHandoff(db, meet.transcripts, meetingId, thread.id);
    db.query("INSERT OR REPLACE INTO message_annotations(work_id,meeting_transcript) VALUES(?,?)")
      .run(message.id, JSON.stringify(transcript));
    const handoff = meetingHandoffText(transcript);
    return { ok: true, value: { text: [message.text, handoff].filter(Boolean).join("\n\n"), images: message.images } };
  } catch (cause) {
    return { ok: false, error: { code: "unavailable", message: cause instanceof Error ? cause.message : String(cause) } };
  }
}

async function enqueuePrompt(sessionId: string, requestId: string, text: string, delivery: "queue" | "steer" | "hardSteer", images: ImageContent[] = []) {
  const sent = await directory.send({ threadId: sessionId, requestId, text, delivery, images });
  const message = unwrap(sent);
  return { accepted: true, workId: message.id, delivery: message.delivery, session: publicSession(sessionRow.get(sessionId)) };
}
function meetingDestination() {
  return [...THREAD_DESTINATIONS.values()].find(destination => destination.id === "home")
    ?? [...THREAD_DESTINATIONS.values()][0];
}
async function insertThread(id: string, name: string, destination: ThreadDestination, model: string,
  meetingId: string | null, message?: string, parentId?: string, settings?: Parameters<typeof directory.spawn>[0]["settings"]) {
  const admitted = workspaceAdmission.resolve(destination.workspaceId);
  if (!admitted.ok) throw new Error(admitted.error.message);
  const thread = unwrap(await directory.spawn({ id, requestId: id, title: name, parentId,
    cwd: admitted.value.cwd, message, settings: { model, ...settings },
    metadata: { workspaceId: destination.workspaceId, profileId: destination.id, meetingId },
  }));
  ensureThreadView(db, thread.id);
  return thread;
}
const unsubscribeThreads = threads.subscribe(change => {
  if ("event" in change) handlePiEvent(change.threadId, change.event);
  else { ensureThreadView(db, change.threadId); signalSync(); }
});
for (const thread of threads.snapshot()) ensureThreadView(db, thread.id);
await inlineImages.start();

const meet = new MeetServer((id) => {
  const row = sessionRow.get(id) as any;
  return Boolean(row && !row.archived_at);
}, undefined, db, (meetingId, rootId) => meetingActivity(db, allThreadRows().filter(row => row.meeting_id === meetingId), rootId, (row) => {
  const runtime = liveProjections.get(row.id);
  return { state: sessionActivity(row), tools: [...(runtime?.activeTools.values() ?? [])], output: runtime?.liveText ?? "" };
}));


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
    const ownedThreadResponse = await threadHttp(threads, req, "/v1/thread-owner");
    if (ownedThreadResponse) return ownedThreadResponse;
    const threadResponse = await threadHttp(directory, req);
    if (threadResponse) return threadResponse;
    const externalResponse = await externalMeetingRequest(req, meet, async (sessionId, meetingId, name) => {
      const existing = sessionRow.get(sessionId) as any;
      if (existing) {
        if (existing.archived_at || existing.meeting_id !== meetingId) throw new Error("The external meeting's thread is unavailable");
        return;
      }
      const destination = meetingDestination();
      const model = THREAD_MODELS.get("astra")!;
      if (!destination) throw new Error("This host needs a configured Astra destination for meetings");
      await insertThread(sessionId, name, destination, model.id, meetingId);
    });
    if (externalResponse) return externalResponse;
    const meetingResponse = await meet.handle(req);
    if (meetingResponse) return meetingResponse;
    const agentMeetingRequest = [API.sessionMeeting, API.sessionMeetingVoice, API.sessionMeetingShare, API.sessionMeetingStop, API.sessionMeetingFrame]
      .map((route) => route.match(req.method, url.pathname)).find(Boolean);
    if (agentMeetingRequest) {
      const row = sessionRow.get(agentMeetingRequest.sessionId) as any;
      if (!row?.meeting_id) return error("This is not a Meet thread", 404);
      return meet.handleAgent(req, row.meeting_id);
    }
    const instructionsRequest = API.sessionInstructions.match(req.method, url.pathname);
    if (instructionsRequest) {
      if (!sessionRow.get(instructionsRequest.sessionId)) return error("Session not found", 404);
      return json({ instructions: threadInstructions(instructionsRequest.sessionId) });
    }
    const imageRequest = API.sessionImage.match(req.method, url.pathname);
    if (imageRequest) {
      const stored = storedContext(imageRequest.sessionId);
      const image = stored && displayContext(imageRequest.sessionId, stored.hash, stored.document).images.get(imageRequest.hash);
      if (!image || !/^image\/(png|jpeg|gif|webp|bmp|avif)$/.test(image.mimeType)) return error("Context image not found", 404);
      const headers = { ...API_CORS_HEADERS, "content-type": image.mimeType, "cache-control": "private, max-age=31536000, immutable", etag: `"${imageRequest.hash}"` };
      if (req.headers.get("if-none-match") === headers.etag) return new Response(null, { status: 304, headers });
      return new Response(Buffer.from(image.data, "base64"), { headers });
    }
    const imagesRequest = API.sessionImages.match(req.method, url.pathname);
    if (imagesRequest) {
      if (!sessionRow.get(imagesRequest.sessionId)) return error("Session not found", 404);
      return json(inlineImages.snapshot(imagesRequest.sessionId));
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
    if (API.environments.match(req.method, url.pathname)) return json({ environments: [ownEnvironment()] });
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
      const result = await voice.status();
      return result.ok ? json(result.value) : error(result.error, result.status);
    }
    if (API.voiceOffer.match(req.method, url.pathname)) {
      const sessionId = url.searchParams.get("sessionId") ?? "";
      const row = sessionRow.get(sessionId) as any;
      if (!row) return error("Session not found", 404);
      if (row.archived_at) return error("Thread is archived", 409);
      const result = await voice.negotiate(row.id, await req.text(), voiceInstructions(row));
      return result.ok ? json(result.value, 201) : error(result.error, result.status);
    }
    const voiceSessionUpdate = API.voiceSessionUpdate.match(req.method, url.pathname);
    const voiceSessionClose = API.voiceSessionClose.match(req.method, url.pathname);
    const voiceSessionRequest = voiceSessionUpdate ?? voiceSessionClose;
    if (voiceSessionRequest) {
      const { sessionId, voiceId } = voiceSessionRequest;
      if (!sessionRow.get(sessionId)) return error("Thread not found", 404);
      if (voiceSessionUpdate) {
        const body = await readBody(req);
        const result = await voice.heartbeat(sessionId, voiceId, Number(body.seconds), body.finalized === true);
        if (result.ok && body.diagnostics && typeof body.diagnostics === "object" && JSON.stringify(body.diagnostics).length <= 12_000) {
          emit(sessionId, "voice", { voiceId, finalized: body.finalized === true, diagnostics: body.diagnostics });
        }
        return result.ok ? json(result.value) : error(result.error, result.status);
      }
      const result = await voice.close(sessionId, voiceId);
      return result.ok ? json(result.value) : error(result.error, result.status);
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

    if (API.notifications.match(req.method, url.pathname)) {
      const after = url.searchParams.has("after") ? Number(url.searchParams.get("after")) : null;
      if (after !== null && (!Number.isSafeInteger(after) || after < 0)) return error("Invalid notification cursor");
      await refreshThreadNotifications();
      return json({ environmentId: ENVIRONMENT_ID, ...idleNotifications(db, after) });
    }
    if (API.workspaces.match(req.method, url.pathname)) {
      return json({ workspaces: [...workspaces.values()] });
    }
    if (API.sync.match(req.method, url.pathname)) {
      try {
        const request = await readBody(req) as SyncRequest;
        lastSyncRequestAt = Date.now();
        if (!dashboardSnapshot) await refreshDashboard();
        if (request.session?.id) await refreshThreadInspection(request.session.id);
        await awaitSync(request, req.signal);
        if (req.signal.aborted) return new Response(null, { status: 499 });
        if (request.session?.id) await refreshThreadInspection(request.session.id);
        if (request.session?.viewing === true && typeof request.session.id === "string") markSessionViewed(request.session.id);
        const sequence = syncSequence;
        const stateVersion = currentStateVersion();
        const fresh = request.epoch !== SUPERVISOR_EPOCH;
        const state = request.stateVersion !== undefined && (fresh || request.stateVersion !== stateVersion) ? supervisorState() : null;
        const dashboard = request.dashboardVersion !== undefined && (fresh || request.dashboardVersion !== dashboardVersion) ? dashboardSnapshot : null;
        const response: SyncResponse = { epoch: SUPERVISOR_EPOCH, seq: sequence, stateVersion, dashboardVersion, state, dashboard, session: null };
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
          const runtime = liveProjections.get(id);
          const events = eventsAfter === undefined ? [] : (db.query("SELECT seq,time,type,payload FROM events WHERE session_id=? AND seq>? ORDER BY seq LIMIT 150")
            .all(id, Math.max(0, Number(eventsAfter) || 0)) as any[]).map((entry) => ({ seq: entry.seq, time: entry.time, type: entry.type, ...JSON.parse(entry.payload) }));
          response.session = {
            context,
            images: fresh || request.session!.imagesVersion !== inlineImages.version(id) ? inlineImages.snapshot(id) : null,
            liveText: textUpdate(`session:${id}:text`, liveTextHash, runtime?.liveText ?? ""),
            liveThinking: textUpdate(`session:${id}:thinking`, liveThinkingHash, runtime?.liveThinking ?? ""),
            events,
          };
        }


        return compressedJson(req, response);
      } catch (cause: any) { return error(cause?.message ?? "Could not synchronize", 400); }
    }
    if (API.sessions.match(req.method, url.pathname)) {
      void refreshPeers();
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
      const body = await readBody(req);
      const requested = body.sessionIds;
      if (!Array.isArray(requested) || new Set(requested).size !== requested.length) return error("Unique sessionIds required");
      const current = activeSessionRows.all();
      if (requested.length !== current.length || requested.some(id => !current.some(row => row.id === id))) return error("Thread list changed", 409);
      db.transaction(() => requested.forEach((id, index) => {
        ensureThreadView(db, id);
        db.query("UPDATE thread_views SET display_order=? WHERE id=?").run(index, id);
      }))();
      signalSync();
      return json({ ok: true });
    }
    if (API.createSession.match(req.method, url.pathname)) {
      try {
        const body = await readBody(req);
        const requestId = String(body.requestId ?? "");
        const saved = requestResult(requestId);
        if (saved) return json(JSON.parse(saved.response), saved.status);
        if (!/^[0-9a-f-]{36}$/i.test(requestId)) return error("Valid requestId required");
        const destination = THREAD_DESTINATIONS.get(String(body.destination ?? "home"));
        if (!destination) return error("Unknown destination");
        const model = String(body.model ?? destination.defaultModel);
        if (!destination.models.includes(model)) return error("Model not available at this destination");
        const id = String(body.sessionId ?? requestId);
        const thread = await insertThread(id, creationName(requestId), destination, model, body.meetingId ?? null, body.message, body.parentId,
          { thinkingLevel: body.thinkingLevel, speed: body.speedMode });
        const response = { session: publicSession(threadRow(thread)) };
        saveRequest(requestId, id, "create", 201, response);
        return json(response, 201);
      } catch (cause: any) { return error(cause.message); }
    }
    const childrenRequest = API.sessionChildren.match(req.method, url.pathname);
    if (childrenRequest) {
      const result = await directChildren(childrenRequest.sessionId);
      return result.ok ? json({ children: result.value }) : threadError(result.error);
    }
    const queueAction = [API.queueItem, API.queueSteer, API.queueHardSteer]
      .map(route => ({ route, match: route.match(req.method, url.pathname) })).find(item => item.match);
    if (queueAction?.match) {
      const { sessionId, workId } = queueAction.match;
      const before = unwrap(await directory.inspect(sessionId));
      const message = before.pending.find(item => item.id === workId);
      if (!message) return error("Pending message not found", 404);
      const result = await directory.control(queueAction.route === API.queueItem
        ? { threadId: sessionId, action: "cancelMessage", messageId: workId }
        : { threadId: sessionId, action: "promoteMessage", messageId: workId, delivery: queueAction.route === API.queueHardSteer ? "hardSteer" : "steer" });
      if (!result.ok) return threadError(result.error);
      return json({ ok: true, workId, text: message.text });
    }

    const sessionRoutes: Array<[string | undefined, (typeof API)[keyof typeof API]]> = [
      [undefined, API.session], [undefined, API.archiveSession], [undefined, API.rejectSessionEdit],
      ["unarchive", API.unarchiveSession], ["prompt", API.sessionPrompt], ["fork", API.sessionFork], ["abort", API.sessionAbort], ["resume", API.sessionResume],
      ["events", API.sessionEvents], ["context", API.sessionContext], ["context", API.patchSessionContext],
      ["context", API.replaceSessionContext], ["settings", API.sessionSettings], ["settings", API.updateSessionSettings],
      ["commands", API.sessionCommands], ["command", API.sessionCommand], ["admission", API.sessionAdmission],
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
      const result = await directory.control({ threadId: id, action: "update", archived: false });
      return result.ok ? json({ ok: true, session: publicSession(threadRow(result.value)) }) : threadError(result.error);
    }
    if (!action && req.method === "PUT") return error("Threads cannot be edited", 405);
    if (!action && req.method === "DELETE") {
      const stopped = await directory.control({ threadId: id, action: "stop", descendants: false });
      if (!stopped.ok) return threadError(stopped.error);
      const archived = await directory.control({ threadId: id, action: "update", archived: true });
      return archived.ok ? json({ ok: true, archived: true, session: publicSession(threadRow(archived.value)) }) : threadError(archived.error);
    }
    if (row.archived_at && action !== "events" && !(action === "context" && req.method === "GET")) return error("Thread is archived", 409);
    if (action === "admission" && req.method === "PUT") return error("Admission belongs to Orchestrator", 405);

    if (action === "context" && req.method === "GET") {
      await refreshThreadInspection(id);
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
        const appended = db.transaction(() => {
          const result = appendContextPatch(db, id, current, capturedAt, splice);
          if (result.ok) inlineImages.acceptContext(id, result.value.document);
          return result;
        })();
        if (!appended.ok) return error(appended.error, 409);
        cacheStoredContext(id, appended.value);
        acknowledgeMessageContext(id, body.finalizesMessage);
        signalSync();
        return json({ ok: true, capturedAt, hash: splice.targetHash });
      } catch (cause: any) { return error(cause?.message ?? "Could not patch model context", 409); }
    }
    if (action === "context" && req.method === "PUT") {
      try {
        return json(storeContextCapture(id, await readBody(req)));
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
      const rt = liveProjections.get(id);
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
      if (forkingSessions.has(id)) return error("Wait for the conversation edit to finish", 409);
      try { return json({ settings: await threadSettings(row) }); }
      catch (e: any) { return error(e.message ?? "Could not load thread settings", 500); }
    }
    if (action === "settings" && req.method === "PUT") {
      const body = await readBody(req);
      const settings: any = {};
      if (body.modelId != null) settings.model = `${body.modelProvider}/${body.modelId}`;
      if (body.thinkingLevel != null) settings.thinkingLevel = body.thinkingLevel;
      if (body.speedMode != null) settings.speed = body.speedMode;
      const result = await directory.control({ threadId: id, action: "settings", settings });
      if (!result.ok) return threadError(result.error);
      if (body.bashTimeoutSeconds != null) {
        if (!BASH_TIMEOUT_OPTIONS.includes(body.bashTimeoutSeconds)) return error("Invalid bash timeout");
        const changed = await directory.control({ threadId: id, action: "update", metadata: { ...row.metadata, bashTimeoutSeconds: body.bashTimeoutSeconds } });
        if (!changed.ok) return threadError(changed.error);
      }
      return json({ settings: await threadSettings(sessionRow.get(id)) });
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
          const rt = liveFor(id);
          if (!ownsSupervisorLease()) return error("Supervisor instance was replaced", 503);
          if (row.state !== "IDLE" || row.pendingMessages) return error("Wait for the thread to become idle before editing", 409);

          const before = await rpc(id, "get_entries") as any;
          const branch = activeSessionEntries(Array.isArray(before.entries) ? before.entries : [], before.leafId);
          const selected = branch.findLast((entry) => entry?.type === "message"
            && entry.message?.role === "user"
            && Number(entry.message.timestamp) === messageTimestamp);
          if (!selected) return error("That user message is no longer on the active conversation branch", 409);
          const forked = await rpc(id, "fork", { id: requestId, entryId: selected.id }) as any;
          if (!ownsSupervisorLease()) return error("Supervisor instance was replaced", 503);
          if (forked.cancelled) return error("Editing from that message was cancelled", 409);
          const after = await rpc(id, "get_entries") as any;
          if (!ownsSupervisorLease()) return error("Supervisor instance was replaced", 503);
          replaceConversationEvents(id, activeSessionEntries(Array.isArray(after.entries) ? after.entries : [], after.leafId));


          rt.liveText = "";
          rt.liveThinking = "";
          rt.thinkingBlockStart = 0;
          rt.pendingContextTextLength = 0;
          rt.pendingContextThinkingLength = 0;
          rt.pendingContextFinalization = null;
          rt.activeTools.clear();
          rt.thinkingActive = false;
          rt.toolProgress.clear();
          displayContexts.delete(id);
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
        const delivery = body.delivery ?? "queue";
        if (!["queue", "steer", "hardSteer"].includes(delivery)) return error("delivery must be queue, steer or hardSteer");

        const roomImages = body.includeMeetingImages === true && row.meeting_id
          ? meet.captureDelegation(row.meeting_id)
          : { images: [], note: "" };
        const message = text + (roomImages.note ? `\n\n${roomImages.note}` : "");
        return json(await enqueuePrompt(id, requestId, message, delivery, roomImages.images), 202);
      } catch (e: any) { return error(e.message ?? "Prompt failed", 400); }
    }
    if (action === "abort" && req.method === "POST") {
      const body = await readBody(req);
      if (typeof body.descendants !== "boolean") return error("descendants boolean required");
      const result = await directory.control({ threadId: id, action: "stop", descendants: body.descendants });
      return result.ok ? json({ ok: true, session: publicSession(threadRow(result.value)) }) : threadError(result.error);
    }
    if (action === "resume" && req.method === "POST") {
      const result = await directory.control({ threadId: id, action: "resume" });
      return result.ok ? json({ ok: true, session: publicSession(threadRow(result.value)) }) : threadError(result.error);
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
void refreshPeers();

unwrap(await threads.start());
const stopAutoArchive = startAutoArchive(directory, AUTO_ARCHIVE_AFTER_MS, error => console.error("[supervisor] auto-archive failed", error));
void refreshThreadNotifications();

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

const uploadPruner = setInterval(pruneUploadTransfers, 60_000);
const namingReceipts = setInterval(reconcileThreadNames, 15_000);
reconcileThreadNames();
function stopSupervisorTimers() {
  stopAutoArchive();
  clearInterval(uploadPruner);
  clearInterval(namingReceipts);
  clearInterval(dashboardTicker);
  stopLedgerSnapshots();
}

async function closeImageGeneration() {
  inlineImages.stop();
  try { await imageProvider?.close(); }
  finally { await inlineImages.close(); }
}

async function releaseSupervisor(exitCode: number) {
  if (shuttingDown) return;
  shuttingDown = true;
  server.stop();
  stopSupervisorTimers();
  unsubscribeThreads();
  threads.suspend();
  runner.detach();
  unwrap(await threads.detach());
  await closeImageGeneration();
  db.close();
  process.exit(exitCode);
}

process.on("SIGTERM", () => void releaseSupervisor(0));
process.on("SIGINT", () => void releaseSupervisor(0));
process.on("SIGUSR2", () => void releaseSupervisor(75));
process.on("SIGHUP", () => void releaseSupervisor(75));
