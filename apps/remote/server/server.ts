import { Database } from "bun:sqlite";
import type { ImageContent } from "@earendil-works/pi-ai";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { configuredOrchestratorThreadUrl } from "./thread-owners";
import { projectThreadNotifications } from "./thread-notifications";
import { startThreadRefresh } from "./thread-refresh";
import { loadThreadModelCatalog, threadSettingsMetadata, modelBrokerUrl, createWorkspaceAdmission, ORCHESTRATOR_CATALOG, OrchestratorClient, CompletionClient, type CompletionInput, catalogAgentType, createSharedImageGenerationService, ThreadService, ThreadDirectory, createThreadClient, importRemoteThreads, createSharedPiSessionOpener, threadHttp, type ThreadInspection, type Thread, type ThreadMessage, type PiEvent, type Result, type SharedImageGenerationService, type PlanUsageSnapshot } from "pi-orchestrator/api";
import { createLiveProjection, settleLiveProjection, restoreLiveProjection, runningChildParents, threadActivity, type LiveProjection } from "./live-projection";
import { InlineImages } from "./inline-images";
import { planCards } from "./catalog-presentation";
import { updateThreadSettings } from "./thread-settings";
import { readMachineUsage } from "./machine-usage";
import { displayAssistantMessage, displayContextDocument, type ContextImage } from "./context-display";
import { LandedWork } from "./queue-landing";
import { updateToolProgress, type ToolProgress } from "./tool-progress";
import { isResponseMetrics, ResponseTiming, type ResponseMetrics } from "./response-metrics";
import { messageFinalizationKey, sha256, type ContextSplice } from "./sync";
import { appendContextPatch, readContext } from "./context-journal";
import { beginSupervisorGeneration, ensureSupervisorSchema, ensureThreadView, removeEventJournal, setThreadColor } from "./database";
import { dismissError, observeError } from "./error-feedback";
import { startLedgerSnapshots } from "./ledger-snapshot";
import { SupervisorRelease } from "./supervisor-release";
import { autoArchiveDelay, startAutoArchive } from "./auto-archive";
import { VoiceClient } from "./voice/client";
import { MeetServer } from "./meet/server";
import { meetingActivity } from "./meet/activity";
import { SessionActivity } from "./session-activity";
import { meetingHandoffText, prepareMeetingHandoff, type HandoffHistory } from "./meet/handoff";
import { meetingThreadInstructions } from "./meet/instructions";
import { externalMeetingRequest } from "./meet/external";
import { liveDevInstructions } from "./skills";
import { configuredThreadDestinations, defaultThreadDestinations, recentThreadModels, threadModelOptions, type ThreadDestination } from "./thread-model-defaults";
import { contextFilesPrompt, listContextFiles, selectContextFiles } from "./thread-context-files";
import { API } from "./api";
import { idleNotifications } from "./notifications";
import { listPersons, publicPerson } from "./persons";
import { ownEnvironment } from "./environments";
import { API_CORS_HEADERS } from "./cors";
import { fileBrowserError, inspectPath, listDirectory, localFileResponse, webResponse } from "./files";
import { governorControls, isGovernorProvider, toggleGovernor } from "./governors";
import { formatProfile, measureLoopLag, profileMainThread } from "./profiler";
import { BASH_TIMEOUT_OPTIONS, DEFAULT_BASH_TIMEOUT_SECONDS, type AgentModelCount, type BashTimeoutSeconds, type Bootstrap, type Dashboard, type QueuedMessage, type Session, isThreadColor, type StreamSubscription, type SupervisorState } from "./protocol";
import { ClientStream, inboxMessaging, PING_INTERVAL_MS, readSubscription } from "./stream";
import { ReconcilePublisher } from "../shared/reconcile";
import { ResourceCache } from "../shared/resource-cache";
import { TranscriptItems, transcriptPage, transcriptWindow } from "./transcript-items";
import { MachineActions } from "./machine-actions";
import { createMessagingService, openCallAudio } from "./messaging";
import { createSpeechService } from "./speech/service";
import { closeAiChat } from "./chat-lifecycle";
import { archivedSessions } from "./archived-sessions";
import { availableUploadPath, storeUpload, uploadName } from "./uploads";
import {
  generatedThreadName,
  localNamingPrompt,
  localReasoningEffort,
  LOCAL_THREAD_NAMING_INSTRUCTION,
  LOCAL_THREAD_NAMING_MAX_TOKENS,
  namingOutcome,
  namingRequestId,
  unnamedThread,
  namingStep,
  namingTranscript,
  parseThreadNamingModel,
  THREAD_NAMING_HISTORY,
  THREAD_NAMING_INSTRUCTION,
  type NamingMessage,
} from "./thread-naming";
import { ensureLocalEngine, loadLocalEngine, localNamingCompletion, withLocalEngine } from "./local-naming";
import { BACKGROUND_RESERVATION_WAIT_SECONDS, EngineReservedError } from "./engine-reservation";

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

const THREAD_MODEL_CATALOG = await loadThreadModelCatalog(AGENT_DIR);
const THREAD_MODELS = threadModelOptions(THREAD_MODEL_CATALOG.configuredModels);
const OFFERED_DESTINATIONS = (process.env.PI_REMOTE_DESTINATIONS ?? "home").split(",").map((id) => id.trim()).filter(Boolean);
const destinationDefinitions: ThreadDestination[] = process.env.PI_REMOTE_THREAD_DESTINATIONS === undefined
  ? defaultThreadDestinations()
  : JSON.parse(process.env.PI_REMOTE_THREAD_DESTINATIONS);
const THREAD_DESTINATIONS = new Map(configuredThreadDestinations(destinationDefinitions
  .filter((destination) => OFFERED_DESTINATIONS.includes(destination.id)), THREAD_MODEL_CATALOG.configuredModels)
  .map((destination) => [destination.id, destination]));

const machineActions = new MachineActions();
const speech = createSpeechService();

/** The absolute context folder of a destination, or null when it offers none. */
function destinationContextDir(destination: ThreadDestination | undefined): string | null {
  if (!destination?.contextDir) return null;
  const workspace = workspaces.get(destination.workspaceId);
  return workspace ? resolve(workspace.path, destination.contextDir) : null;
}

// Which models each profile used most recently. Archived threads never move
// again, so the answer is seeded once from every thread and then kept current
// from the threads that change, instead of walking thousands of rows on each
// inbox refresh.
const modelRecency = new Map<string, { profileId: string; model: string; updatedAt: number }>();
function noteModelRecency(thread: Thread, lookup: ThreadLookup = liveThread): boolean {
  const profileId = String(remotePlacement(thread, lookup).profileId ?? "home");
  const key = `${profileId}\u0000${thread.settings.model}`;
  const known = modelRecency.get(key);
  if (known && known.updatedAt >= thread.updatedAt) return false;
  modelRecency.set(key, { profileId, model: thread.settings.model, updatedAt: thread.updatedAt });
  return true;
}
function threadStartProfiles() {
  const history = [...modelRecency.values()];
  return [...THREAD_DESTINATIONS.values()].map((destination) => {
    const contextDir = destinationContextDir(destination);
    return {
      id: destination.id,
      label: destination.label,
      icon: destination.icon,
      accent: destination.accent,
      defaultModel: destination.defaultModel,
      models: recentThreadModels(destination, history, THREAD_MODELS).map((id) => {
        const model = THREAD_MODELS.get(id);
        if (!model) throw new Error(`Unknown thread model ${id} in profile ${destination.id}`);
        return { id: model.id, label: model.label, icon: model.icon, accent: model.accent };
      }),
      ...(contextDir ? { contexts: listContextFiles(contextDir) } : {}),
    };
  });
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
/** Live timing of the response each session is streaming right now. */
const responseTiming = new ResponseTiming();
const activity = new SessionActivity(() => now());
const contextFinalizedMessages = new Map<string, string>();
const forkingSessions = new Set<string>();
let shuttingDown = false;
const runner = createSharedPiSessionOpener({ dataDir: DATA });
const threads = new ThreadService({
  attachSession: runner.attachSession,
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
const fleetUrl = configuredOrchestratorThreadUrl();
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
    const refresh = projectThreadNotifications(db, owner.id, owner.api)
      .then(() => { observeError(db, `notifications:${owner.id}`, null); if (notificationErrors.delete(owner.id)) signalSync(); })
      .catch(cause => {
        const message = cause instanceof Error ? cause.message : String(cause);
        observeError(db, `notifications:${owner.id}`, message);
        if (notificationErrors.get(owner.id) !== message) { notificationErrors.set(owner.id, message); signalSync(); }
      })
      .finally(() => { notificationRefreshes.delete(owner.id); signalSync(); pushNotifications(); });
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
      if (!page.ok) { observeError(db, "peer:fleet", page.error.message); if (peerError !== page.error.message) { peerError = page.error.message; signalSync(); } return; }
      for (const thread of page.value.threads) {
        if (threads.get(thread.id)) throw new Error(`Thread ${thread.id} has two owners`);
        next.set(thread.id, thread);
      }
      cursor = page.value.nextCursor;
    } while (cursor);
    const changed = peerError !== null || JSON.stringify([...next]) !== JSON.stringify([...peerThreads]);
    peerError = null;
    observeError(db, "peer:fleet", null);
    peerThreads.clear();
    peerChildren.clear();
    for (const thread of next.values()) if (thread.parentId) peerChildren.set(thread.parentId, true);
    for (const [id, thread] of next) { peerThreads.set(id, thread); ensureThreadView(db, id); }
    for (const thread of next.values()) noteModelRecency(thread);
    if (changed) signalSync();
  })().catch(cause => {
    const message = cause instanceof Error ? cause.message : String(cause);
    observeError(db, "peer:fleet", message);
    if (peerError !== message) { peerError = message; signalSync(); }
  }).finally(() => { peerRefresh = null; });
  return peerRefresh;
}
const inspectingThreads = new Map<string, Promise<void>>();
async function refreshThreadInspection(id: string) {
  const local = threads.get(id);
  if (local && !peerInspections.has(id) && storedContext(id)) return;
  const known = peerInspections.get(id);
  const listed = peerThreads.get(id);
  if (!local && known && listed?.state === "idle" && known.thread.revision === listed.revision) return;
  const pending = inspectingThreads.get(id);
  if (pending) return pending;
  const operation = inspectThread(id, Boolean(local)).finally(() => inspectingThreads.delete(id));
  inspectingThreads.set(id, operation);
  return operation;
}
async function inspectThread(id: string, local: boolean) {
  const result = await directory.inspect(id);
  if (!result.ok) throw new Error(result.error.message);
  const inspection = result.value;
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
  },
});

function compressedJson(req: Request, data: unknown, status = 200): Response {
  const encoded = JSON.stringify(data);
  const headers: Record<string, string> = {
    ...API_CORS_HEADERS,
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

let imageProvider: SharedImageGenerationService | undefined;
const inlineImages = new InlineImages(db, join(DATA, "inline-images"), async (input, signal) => {
  try {
    imageProvider ??= createSharedImageGenerationService({ ledgerPath: ORCHESTRATOR_DB_PATH });
    return await imageProvider.generateImageWithSharedAccount(input, { signal });
  } catch (cause) {
    return { ok: false, error: { message: cause instanceof Error ? cause.message : String(cause) } };
  }
}, signalSync, 2, ownsSupervisorLease);

/** Live event streams by id, the only thing a client keeps open. */
const streams = new Map<string, ClientStream>();
const reconciledState = new ReconcilePublisher({ maxHistoryPerResource: 32 });

// Anything that can change the inbox projection, the messaging snapshot or a
// client's images calls this. The projection is rebuilt once per burst, and a
// stream only hears about it when its own rows differ.
const STATE_COALESCE_MS = 25;
let statePushTimer: ReturnType<typeof setTimeout> | null = null;
function signalSync() {
  if (statePushTimer || shuttingDown) return;
  statePushTimer = setTimeout(() => {
    statePushTimer = null;
    refreshState();
  }, STATE_COALESCE_MS);
}

// The Machine screen changes on its own clock: meters, load, agent lifecycles
// and host toggles. Nothing else needs to hear about it, so it is refreshed
// only while a client has that screen open and travels only to those streams.
const DASHBOARD_TICK_MS = Math.max(1_000, Number(process.env.PI_REMOTE_DASHBOARD_TICK_MS ?? "10000"));
let dashboardVersion = 1;
let dashboardSnapshot: Dashboard | null = null;
let dashboardEncoded = "";
let dashboardRefreshes = Promise.resolve();
let dashboardBusy = false;
async function buildDashboard(): Promise<Dashboard> {
  await refreshPeers();
  const [agents, actions] = await Promise.all([activeAgents(), machineActions.refresh()]);
  return {
    plans: planCards(planUsage),
    governors: governorControls(orchestrator),
    actions,
    machine: readMachineUsage(),
    modelCounts: agents.models,
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
      for (const stream of streams.values()) if (stream.subscription.dashboard) stream.publish({ type: "dashboard", dashboard: next });
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
  if (!dashboardBusy && dashboardSubscribers()) void refreshDashboard();
}, DASHBOARD_TICK_MS);
function dashboardSubscribers(): boolean {
  for (const stream of streams.values()) if (stream.subscription.dashboard) return true;
  return false;
}

// A phone renders streamed markdown on every frame it receives; 30 frames a
// second reads as continuous and halves the events of the previous 16 ms.
const LIVE_SYNC_INTERVAL_MS = 33;
let liveSyncTimer: ReturnType<typeof setTimeout> | null = null;
let liveSyncPending = false;
function signalLiveSync() {
  if (liveSyncTimer) {
    liveSyncPending = true;
    return;
  }
  pushLive();
  liveSyncTimer = setTimeout(() => {
    liveSyncTimer = null;
    if (liveSyncPending) {
      liveSyncPending = false;
      signalLiveSync();
    }
  }, LIVE_SYNC_INTERVAL_MS);
}

type StoredContext = { capturedAt: number; document: string; hash: string };
const contextCacheLimits = { entries: 32, bytes: 64 * 1024 * 1024 };
const storedContextCache = new ResourceCache<StoredContext | null>(contextCacheLimits);
const displayContexts = new ResourceCache<{ sourceHash: string; document: string; hash: string; images: Map<string, ContextImage> }>(contextCacheLimits);
const inspectedContexts = new WeakMap<ThreadInspection, StoredContext | null>();

/** The newest user and assistant messages of this thread, from the context the
 * agent actually holds. Naming and Voice both want to read the conversation,
 * and the captured context is where the conversation is. */
function recentContextMessages(sessionId: string, limit: number): Array<{ role: "user" | "assistant"; text: string }> {
  const stored = storedContext(sessionId);
  if (!stored) return [];
  let messages: any[];
  try { messages = JSON.parse(stored.document).messages ?? []; } catch { return []; }
  const found: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (const message of messages) {
    const role = message?.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = contentText(message.content).trim();
    if (text) found.push({ role, text });
  }
  return found.slice(-limit);
}

/** Finished response measurements of this session, keyed by the message each
 * one belongs to, exactly as the streamed thinking is joined. */
function responseMetricsByMessage(sessionId: string): Map<string, ResponseMetrics> {
  const result = new Map<string, ResponseMetrics>();
  const rows = db.query("SELECT finalizes_message,metrics FROM message_facts WHERE session_id=? AND metrics IS NOT NULL")
    .all(sessionId) as Array<{ finalizes_message: string; metrics: string }>;
  for (const row of rows) {
    try {
      const metrics = JSON.parse(row.metrics);
      if (isResponseMetrics(metrics)) result.set(row.finalizes_message, metrics);
    } catch {}
  }
  return result;
}

function streamedThinkingByMessage(sessionId: string): Map<string, string> {
  const result = new Map<string, string>();
  const rows = db.query("SELECT finalizes_message,thinking FROM message_facts WHERE session_id=? AND thinking IS NOT NULL")
    .all(sessionId) as Array<{ finalizes_message: string; thinking: string }>;
  for (const row of rows) if (row.thinking) result.set(row.finalizes_message, row.thinking);
  return result;
}

function displayContext(sessionId: string, sourceHash: string, sourceDocument: string) {
  const cached = displayContexts.get(sessionId);
  if (cached?.sourceHash === sourceHash) return cached;
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
  }, liveProjections.get(sessionId)?.toolProgress.values(), responseMetricsByMessage(sessionId));
  const projected = { sourceHash, document, hash: sha256(document), images };
  displayContexts.set(sessionId, projected, document.length * 2 + [...images.values()].reduce((bytes, image) => bytes + image.data.length * 2, 0));
  return projected;
}

function cacheStoredContext(sessionId: string, stored: { capturedAt: number; document: string; hash: string } | null) {
  if (stored && threads.get(sessionId)) peerInspections.delete(sessionId);
  const known = storedContextCache.get(sessionId) ?? null;
  const progress = liveProjections.get(sessionId)?.toolProgress;
  if (progress?.size && stored && known?.hash !== stored.hash) {
    for (const message of JSON.parse(stored.document).messages ?? []) {
      if (message?.role === "toolResult") progress.delete(message.toolCallId);
    }
  }
  storedContextCache.set(sessionId, stored, stored ? stored.document.length * 2 : 4);
  if (known?.hash !== stored?.hash) signalTranscript(sessionId);
}

/** The display projection of this session is stale; rebuild and push it. */
function invalidateDisplayContext(sessionId: string) {
  displayContexts.delete(sessionId);
  signalTranscript(sessionId);
}

function storedContext(sessionId: string): { capturedAt: number; document: string; hash: string } | null {
  const peer = peerInspections.get(sessionId);
  if (peer) {
    if (inspectedContexts.has(peer)) return inspectedContexts.get(peer)!;
    const document = peer.context ? JSON.stringify(peer.context) : null;
    const stored = document === null ? null : { capturedAt: peer.thread.updatedAt, document, hash: sha256(document) };
    inspectedContexts.set(peer, stored);
    return stored;
  }
  const cached = storedContextCache.get(sessionId);
  if (cached !== undefined) return cached;
  const stored = readContext(db, sessionId);
  cacheStoredContext(sessionId, stored);
  return stored;
}

function clearStoredContext(sessionId: string) {
  db.transaction(() => {
    db.query("DELETE FROM session_context_patches WHERE session_id=?").run(sessionId);
    db.query("DELETE FROM session_contexts WHERE session_id=?").run(sessionId);
  })();
  cacheStoredContext(sessionId, null);
  invalidateDisplayContext(sessionId);
  signalSync();
}

// Work the runtime accepted whose text has since appeared in the agent's
// context. Until then the queue keeps showing it as sent to the agent. A turn
// grows the context in patches, so both the full capture and the patch mark it;
// a patch is parsed only when a delivered message is still unaccounted for.
const landedWork = new LandedWork();
function markLandedWork(id: string, readContext: () => { messages?: unknown[] }) {
  if (!threads.get(id)) return;
  landedWork.mark(id, threads.pending(id).filter(message => message.insertedAt).map(message => ({ id: message.id, text: message.text })), readContext);
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
    markLandedWork(id, () => context);
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

// The meeting root is the conversation thread the room is attached to; Voice hard-steers it on
// every handoff, so it routes work to worker threads. Workers inherit the meeting through their parent.
function meetingInstructions(sessionId: string, audience: "thread" | "voice" = "thread"): string {
  const thread = threads.get(sessionId) ?? peerThreads.get(sessionId);
  if (!thread || !remotePlacement(thread).meetingId) return "";
  if (audience === "voice") return liveDevInstructions();
  return meetingThreadInstructions(thread.role === "worker" ? "worker" : "root");
}

/** The chosen context files of a thread, whole, for its system prompt. Children do not inherit their parent's choice. */
function chosenContextFiles(sessionId: string): string {
  const thread = threads.get(sessionId);
  const names = thread?.metadata?.contextFiles;
  if (!Array.isArray(names) || !names.length) return "";
  const directory = destinationContextDir(THREAD_DESTINATIONS.get(String(thread!.metadata!.profileId ?? "")));
  if (!directory) return "";
  return contextFilesPrompt(directory, names.filter((name): name is string => typeof name === "string"));
}

function threadInstructions(sessionId: string, audience: "thread" | "voice" = "thread"): string {
  const snapshot = inlineImages.snapshot(sessionId);
  const registry = snapshot.images.map(({ id, state, refs, path, paths, error, conflict }) => ({ id, state, refs, path, paths, error, conflict }));
  return [
    audience === "thread" ? chosenContextFiles(sessionId) : "",
    meetingInstructions(sessionId, audience),
    registry.length ? `Pi Remote image registry: ${JSON.stringify({ version: snapshot.version, images: registry })}` : "",
  ].filter(Boolean).join("\n\n");
}

function voiceInstructions(row: any): string {
  const history = recentContextMessages(row.id, 8)
    .map((message) => `${message.role === "user" ? "User" : "Agent"}: ${message.text.slice(0, 1_500)}`)
    .join("\n");
  const policy = readFileSync(new URL("./voice/delegation-policy.md", import.meta.url), "utf8").trim();
  return [
    policy,
    `Connected Pi thread: ${JSON.stringify({ id: row.id, name: row.name, meeting: Boolean(row.meeting_id) })}`,
    threadInstructions(row.id, "voice"),
    history ? `Recent thread transcript:\n${history}` : "",
  ].filter(Boolean).join("\n\n");
}

type ThreadLookup = (id: string) => Thread | null;
const liveThread: ThreadLookup = id => threads.get(id) ?? peerThreads.get(id) ?? null;
/** A worker's placement is inherited: the nearest ancestor that set each key wins. */
function remotePlacement(thread: Thread, lookup: ThreadLookup = liveThread): Record<string, unknown> {
  const seen = new Set<string>();
  const placement: Record<string, unknown> = {};
  let current: Thread | null = thread;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    for (const key of ["workspaceId", "profileId", "meetingId", "bashTimeoutSeconds"]) {
      if (!(key in placement) && current.metadata && key in current.metadata) placement[key] = current.metadata[key];
    }
    current = current.parentId ? lookup(current.parentId) : null;
  }
  return placement;
}
interface ThreadView { id: string; idle_unread: number; named_at_message_count: number; color: Session["color"] }
const threadViewRow = db.query("SELECT id,idle_unread,named_at_message_count,color FROM thread_views WHERE id=?");
const threadViewRows = db.query("SELECT id,idle_unread,named_at_message_count,color FROM thread_views");
/**
 * One consistent read of the threads this supervisor shows. Everything a
 * projection derives, placement, views, parents, comes from this read rather
 * than from a query per thread: the inbox is rebuilt on every burst of
 * runtime events, and a long-lived account has thousands of threads.
 */
function threadTable(options: { archived?: boolean } = {}) {
  const local = threads.snapshot(options);
  const byId = new Map<string, Thread>();
  for (const thread of local) byId.set(thread.id, thread);
  for (const thread of peerThreads.values()) byId.set(thread.id, thread);
  // An active worker's parent may itself be archived; placement still comes from it.
  const lookup: ThreadLookup = id => byId.get(id) ?? threads.get(id) ?? null;
  const views = new Map((threadViewRows.all() as ThreadView[]).map(view => [view.id, view]));
  const all = [...local, ...peerThreads.values()];
  return { local, all, lookup, rows: () => all.map(thread => threadRow(thread, lookup, views.get(thread.id) ?? null)) };
}
function threadRow(thread: Thread, lookup: ThreadLookup = liveThread, view: ThreadView | null = threadViewRow.get(thread.id) as ThreadView | null): any {
  const meta = { ...remotePlacement(thread, lookup), ...thread.metadata };
  const [provider, ...modelParts] = thread.settings.model.split("/");
  const model = { provider, modelId: modelParts.join("/") };
  // A failed execution is a notice in the thread's own transcript and an unread
  // marker on its row; it is not a second status the person has to dismiss.
  return { ...thread, name: thread.title, workspace_id: meta.workspaceId ?? thread.cwd,
    session_path: thread.sessionFile,
    initial_model: model?.modelId ?? thread.settings.model, current_provider: model?.provider ?? "",
    initial_provider: model?.provider ?? "", initial_thinking: thread.settings.thinkingLevel,
    meeting_id: meta.meetingId ?? null, profile_id: meta.profileId ?? "home",
    service_tier: thread.settings.speed === "priority" ? "priority" : "default",
    bash_timeout_seconds: meta.bashTimeoutSeconds ?? DEFAULT_BASH_TIMEOUT_SECONDS,
    archived_at: meta.archived ? meta.archivedAt ?? new Date(thread.updatedAt).toISOString() : null,
    idle_unread: view?.idle_unread ?? 0, named_at_message_count: view?.named_at_message_count ?? 0,
    color: view?.color ?? null,
    created_at: new Date(thread.createdAt).toISOString(), updated_at: new Date(thread.updatedAt).toISOString() };
}
const sessionRow = { get(id: string) { const found = threads.get(id) ?? peerThreads.get(id); return found ? threadRow(found) : null; } };
function allThreadRows() { return threadTable().rows(); }
const activeSessionRows = { all: () => threadTable({ archived: false }).rows().filter(row => !row.archived_at) };
function archivedSessionPage(params = new URLSearchParams()) {
  return archivedSessions(allThreadRows(), params, id => Boolean(threads.get(id)));
}

const supervisorEpochRow = db.query("SELECT value FROM metadata WHERE key='supervisor_epoch'");
function ownsSupervisorLease(): boolean {
  try { return (supervisorEpochRow.get() as any)?.value === SUPERVISOR_EPOCH; }
  catch { return false; }
}

// One step of visible work. Voice and the meeting panel watch this window;
// nothing here is conversation history, which the native transcript and the
// captured context own.
function emit(sessionId: string, type: string, payload: Record<string, unknown> = {}, receiptId: string | null = null): number {
  if (!ownsSupervisorLease()) return 0;
  const seq = activity.add(sessionId, type, payload, receiptId);
  if (!seq) return 0;
  if (type === "user" || type === "assistant") countThreadMessage(sessionId);
  signalSync();
  // Deliver with the next live frame rather than waiting for the thread's
  // state to move.
  signalLiveSync();
  return seq;
}

/** Naming asks how far the conversation has come. The count has to keep
 * climbing across a compaction that shortens the context, so the supervisor
 * counts message boundaries as it sees them. */
function countThreadMessage(sessionId: string) {
  ensureThreadView(db, sessionId);
  db.query("UPDATE thread_views SET message_count=message_count+1 WHERE id=?").run(sessionId);
}

function recordMessageFact(sessionId: string, finalizesMessage: string, column: "thinking" | "metrics", value: string) {
  ensureThreadView(db, sessionId);
  db.query(`INSERT INTO message_facts(session_id,finalizes_message,${column}) VALUES(?,?,?)
    ON CONFLICT(session_id,finalizes_message) DO UPDATE SET ${column}=excluded.${column}`)
    .run(sessionId, finalizesMessage, value);
}

function recordThinkingEvent(sessionId: string, text: string, finalizesMessage: string) {
  if (!ownsSupervisorLease() || !text) return;
  invalidateDisplayContext(sessionId);
  recordMessageFact(sessionId, finalizesMessage, "thinking", text);
  signalSync();
}

function recordResponseMetrics(sessionId: string, metrics: ResponseMetrics | null, finalizesMessage: string) {
  if (!ownsSupervisorLease() || !metrics) return;
  invalidateDisplayContext(sessionId);
  recordMessageFact(sessionId, finalizesMessage, "metrics", JSON.stringify(metrics));
  signalSync();
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

function recentThreadMessages(sessionId: string): NamingMessage[] {
  return recentContextMessages(sessionId, THREAD_NAMING_HISTORY);
}

// A local engine answers in a couple of seconds and keeps no ledger receipt: the supervisor waits for
// the title in place, and a restart mid-request simply leaves the thread for its next naming point.
// Naming is background work, so it holds the engine's maintenance reservation for the whole attempt
// and gives up immediately when somebody else has it.
async function localThreadName(messages: NamingMessage[]): Promise<string> {
  const selection = parseThreadNamingModel(THREAD_NAMING_MODEL);
  if (selection.kind !== "local") throw new Error("Thread naming model is not a local engine");
  const prompt = localNamingPrompt(messages);
  const engine = await loadLocalEngine(AGENT_DIR, selection.engine);
  return withLocalEngine(engine, BACKGROUND_RESERVATION_WAIT_SECONDS, async () => {
    await ensureLocalEngine(engine);
    return localNamingCompletion(engine, { model: selection.model, systemPrompt: LOCAL_THREAD_NAMING_INSTRUCTION, prompt,
      reasoningEffort: localReasoningEffort(selection.thinkingLevel), maxTokens: LOCAL_THREAD_NAMING_MAX_TOKENS });
  });
}

// Threads whose naming met a maintenance reservation. They are due again, and the naming reconcile
// tick retries them once the engine is free instead of waiting for the thread's next message.
const reservedNames = new Set<string>();

type NamingReceipt = { requestId: string; messageCount: number; input: CompletionInput };
interface NamingView { id: string; message_count: number; named_at_message_count: number; naming_attempted_count: number; naming_request: string | null }
const namingViewRows = db.query("SELECT id,message_count,named_at_message_count,naming_attempted_count,naming_request FROM thread_views");
function namingInput(transcript: string): CompletionInput {
  const parts = THREAD_NAMING_MODEL.split(":");
  if (parts.length > 2) throw new Error("Invalid naming model selection");
  const physical = parts[0]!.split("/").at(-1)!;
  const model = ORCHESTRATOR_CATALOG.models.find(candidate => candidate.id === physical || candidate.model === physical);
  if (model?.id !== "luna") throw new Error("Thread naming completion currently supports Luna");
  const thinkingLevel = parts[1];
  if (thinkingLevel && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinkingLevel)) throw new Error("Invalid naming thinking level");
  return { model: "luna", systemPrompt: THREAD_NAMING_INSTRUCTION, prompt: transcript,
    speed: "standard", ...(thinkingLevel ? { thinkingLevel } : {}) } as CompletionInput;
}
function namingError(id: string, message: string | null) {
  const view = db.query("SELECT naming_attempted_count FROM thread_views WHERE id=?").get(id) as any;
  observeError(db, `naming:${id}`, message, String(view?.naming_attempted_count ?? 0));
  const result = db.query("UPDATE thread_views SET naming_error=? WHERE id=? AND naming_error IS NOT ?").run(message, id, message);
  if (result.changes) signalSync();
}
async function nameThread(sessionId: string): Promise<void> {
  if (namingThreads.has(sessionId) || shuttingDown) return;
  namingThreads.add(sessionId);
  try {
    const row = sessionRow.get(sessionId);
    if (!row) { reservedNames.delete(sessionId); return; }
    ensureThreadView(db, sessionId);
    const view = db.query("SELECT * FROM thread_views WHERE id=?").get(sessionId) as any;
    const messageCount = Number(view.message_count ?? 0);
    let receipt = view.naming_request ? JSON.parse(view.naming_request) as NamingReceipt : null;
    const attemptedBefore = Number(view.naming_attempted_count ?? 0);
    const step = namingStep({ name: row.name, messageCount, namedAtMessageCount: Number(view.named_at_message_count ?? 0), attemptedCount: attemptedBefore, hasReceipt: !!receipt });
    if (step === "idle") { reservedNames.delete(sessionId); return; }
    // Naming reads the conversation from the context mirror. Until the mirror holds this thread's
    // messages there is nothing to title, and an empty prompt is a request no completion owner
    // accepts, so the thread stays due for the next message or reconcile tick.
    const conversation = () => {
      const messages = recentThreadMessages(sessionId);
      if (!messages.length && ownsSupervisorLease()) namingError(sessionId, null);
      return messages;
    };
    if (THREAD_NAMING_MODEL.startsWith("local/")) {
      if (receipt) db.query("UPDATE thread_views SET naming_request=NULL WHERE id=?").run(sessionId);
      const messages = conversation();
      if (!messages.length) return;
      db.query("UPDATE thread_views SET naming_attempted_count=? WHERE id=?").run(messageCount, sessionId);
      let output: string;
      try { output = await localThreadName(messages); }
      catch (cause) {
        if (!(cause instanceof EngineReservedError)) throw cause;
        // Maintenance is not a naming failure. Leave the thread due, keep it out of the error feed and
        // let the reconcile tick try again after the lease.
        db.query("UPDATE thread_views SET naming_attempted_count=? WHERE id=?").run(attemptedBefore, sessionId);
        reservedNames.add(sessionId);
        if (ownsSupervisorLease()) namingError(sessionId, null);
        return;
      }
      reservedNames.delete(sessionId);
      const title = generatedThreadName(output);
      if (!ownsSupervisorLease() || shuttingDown) return;
      unwrap(threads.update(sessionId, { title }));
      db.query("UPDATE thread_views SET named_at_message_count=?,naming_error=NULL WHERE id=?").run(messageCount, sessionId);
      signalSync();
      return;
    }
    if (!namingClient) {
      db.query("UPDATE thread_views SET naming_request=NULL,naming_attempted_count=? WHERE id=?").run(messageCount, sessionId);
      namingError(sessionId, "Thread naming has no explicitly permitted same-person completion owner");
      return;
    }
    if (!receipt) {
      const messages = conversation();
      if (!messages.length) return;
      const input = namingInput(namingTranscript(messages));
      receipt = { requestId: namingRequestId(sessionId, messageCount, input), messageCount, input };
      db.query("UPDATE thread_views SET naming_request=?,naming_attempted_count=? WHERE id=?").run(JSON.stringify(receipt), messageCount, sessionId);
    }
    const submitted = step === "generate";
    let result = submitted ? await namingClient.submit(receipt.requestId, receipt.input) : await namingClient.get(receipt.requestId);
    if (!result.ok && result.error.code === "not-found") result = await namingClient.submit(receipt.requestId, receipt.input);
    if (!ownsSupervisorLease() || shuttingDown) return;
    const outcome = namingOutcome(result);
    if (outcome.kind === "pending") { namingError(sessionId, null); return; }
    if (outcome.kind === "failed") {
      if (!outcome.keepReceipt) db.query("UPDATE thread_views SET naming_request=NULL WHERE id=?").run(sessionId);
      if (outcome.regenerate) db.query("UPDATE thread_views SET naming_attempted_count=? WHERE id=?").run(Number(view.named_at_message_count ?? 0), sessionId);
      namingError(sessionId, outcome.message);
      return;
    }
    db.query("UPDATE thread_views SET naming_request=NULL WHERE id=?").run(sessionId);
    const title = generatedThreadName(outcome.text);
    unwrap(threads.update(sessionId, { title }));
    db.query("UPDATE thread_views SET named_at_message_count=?,naming_error=NULL WHERE id=?").run(receipt.messageCount, sessionId);
    signalSync();
  } catch (cause) {
    if (ownsSupervisorLease()) namingError(sessionId, cause instanceof Error ? cause.message : String(cause));
  } finally { namingThreads.delete(sessionId); }
}
function scheduleThreadNameIfDue(sessionId: string) { void nameThread(sessionId); }
/** Every thread this supervisor owns that still needs a title, whether it is mid-request, waiting for
 * a local engine, or was left numbered by an earlier process. */
function reconcileThreadNames() {
  const due = new Set(reservedNames);
  for (const row of db.query("SELECT id FROM thread_views WHERE naming_request IS NOT NULL").all() as {id: string}[]) due.add(row.id);
  const views = new Map((namingViewRows.all() as NamingView[]).map(view => [view.id, view]));
  const live = new Set<string>();
  for (const thread of threads.snapshot({ archived: false })) {
    live.add(thread.id);
    const view = views.get(thread.id);
    if (namingStep({ name: thread.title, messageCount: Number(view?.message_count ?? 0), namedAtMessageCount: Number(view?.named_at_message_count ?? 0),
      attemptedCount: Number(view?.naming_attempted_count ?? 0), hasReceipt: !!view?.naming_request }) !== "idle") due.add(thread.id);
  }
  // An archived or departed thread will never be named again, so its last failure is not something
  // the person can act on. It leaves the error feed with the conversation.
  if (ownsSupervisorLease()) {
    for (const row of db.query("SELECT id FROM thread_views WHERE naming_error IS NOT NULL").all() as {id: string}[]) {
      if (!live.has(row.id)) namingError(row.id, null);
    }
  }
  for (const id of due) void nameThread(id);
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
  for (const row of allThreadRows()) if (row.state === "running") {
    running++; addAgentModel(models, row.settings.model);
  }
  return { running, models: sortedAgentModels(models) };
}

// The inbox projection. Archived threads live behind `/v1/sessions/archived`
// and the messaging inbox travels as its own event, so this is only what every
// client's thread list needs.
function supervisorState(): SupervisorState {
  const table = threadTable({ archived: false });
  let peerArchived = 0;
  for (const thread of peerThreads.values()) if (thread.metadata?.archived) peerArchived++;
  return {
    sessions: publicSessions(table.rows().filter(row => !row.archived_at), table.local),
    archivedTotal: threads.archivedCount() + peerArchived,
    ownerErrors: [
      { owner: "fleet", feedback: peerError ? observeError(db, "peer:fleet", peerError) : null },
      ...[...notificationErrors].map(([owner, message]) => ({ owner, feedback: observeError(db, `notifications:${owner}`, message) })),
      ...(db.query("SELECT id,naming_error,naming_attempted_count FROM thread_views WHERE naming_error IS NOT NULL").all() as any[])
        .map(row => ({ owner: `Thread ${sessionRow.get(row.id)?.name ?? row.id} naming`,
          feedback: observeError(db, `naming:${row.id}`, row.naming_error, String(row.naming_attempted_count)) })),
    ].flatMap(({ owner, feedback }) => feedback ? [{ owner, ...feedback }] : []),
  };
}

// List rows carry queue counts, not the queued text. A stream fills in the
// text for the one session its client has open; `queuedMessagesFor` is what
// makes that row differ from the shared projection.
function publicSessions(rows: any[], local: Thread[] = threads.snapshot({ archived: false })): Session[] {
  const parents = new Set(local.map(thread => thread.parentId));
  const runningParents = runningChildParents(local, peerThreads.values());
  return rows.map(row => publicSession(row, parents.has(row.id) || Boolean(peerChildren.get(row.id)), runningParents.has(row.id), false));
}
function pendingMessages(id: string) {
  return threads.get(id) ? threads.pending(id) : peerInspections.get(id)?.pending ?? [];
}
function queuedMessagesFor(id: string): QueuedMessage[] {
  return pendingMessages(id).filter(message => !message.insertedAt || (threads.get(id) && !landedWork.has(id, message.id))).map(message => {
    // A message the runtime has taken cannot be edited, steered or removed;
    // one still waiting can be all three, whether or not the thread is held.
    const waiting = (message.state ?? "queued") === "queued";
    return {
      id: message.id, text: message.text, delivery: message.delivery,
      state: waiting ? "queued" as const : "dispatched" as const,
      canSteer: waiting && message.delivery === "queue",
      canHardSteer: waiting,
      canCancel: waiting,
      createdAt: new Date(message.createdAt).toISOString(),
    };
  });
}
function publicSession(row: any,
  hasChildren = threads.snapshot({ archived: false }).some(thread => thread.parentId === row.id) || Boolean(peerChildren.get(row.id)),
  hasRunningChildren = runningChildParents(threads.snapshot({ archived: false }), peerThreads.values()).has(row.id),
  queued = true,
): Session {
  const pending = pendingMessages(row.id);
  const live = liveProjections.get(row.id);
  return {
    id: row.id, parentId: row.parentId,
    hasChildren,
    origin: threads.get(row.id) ? "person" : "fleet",
    model: row.settings.model, name: row.name, color: row.color, cwd: row.cwd,
    workspaceName: workspaces.get(row.workspace_id)?.name ?? row.cwd,
    environment: ENVIRONMENT_ID, state: row.state, held: Boolean(row.held),
    activity: threadActivity(row.state, live, hasRunningChildren),
    activeTools: [...(live?.activeTools.values() ?? [])],
    provider: canonicalModelProvider(String(row.current_provider)).replace(/^openai-codex$/, "openai"),
    createdAt: row.created_at, updatedAt: row.updated_at, revision: row.revision,
    idleUnread: Boolean(row.idle_unread),
    queuedMessages: queued ? queuedMessagesFor(row.id) : [], archivedAt: row.archived_at,
  };
}

// ---------------------------------------------------------------------------
// The event stream
//
// Shared work happens once: the inbox projection is built and encoded per
// version, the dashboard once per refresh, the transcript once per capture.
// Each stream then sends its client only what that client does not already
// hold, which it remembers on the ClientStream.

function bootstrap(): Bootstrap {
  return { environmentId: ENVIRONMENT_ID, home: HOME, threadStarts: threadStartProfiles(), speech: speech?.catalog() ?? null };
}

let stateEncoded = "";
let stateSnapshot: SupervisorState = { sessions: [], archivedTotal: 0, ownerErrors: [] };

function currentState(): SupervisorState {
  if (!stateEncoded) projectState();
  return stateSnapshot;
}

/** Rebuild the shared projection; the version moves only when it really changed. */
function projectState(): void {
  const state = supervisorState();
  const encoded = JSON.stringify(state);
  if (encoded === stateEncoded) return;
  stateEncoded = encoded;
  stateSnapshot = state;
}

function refreshState(): void {
  for (const stream of streams.values()) {
    if (stream.subscription.viewing && stream.subscription.session) markSessionViewed(stream.subscription.session);
  }
  projectState();
  for (const stream of streams.values()) sendState(stream);
  pushMessaging();
  pushBootstrap();
  for (const stream of streams.values()) sendImages(stream);
}

let bootstrapEncoded = "";
function pushBootstrap(): void {
  if (!streams.size) return;
  const current = bootstrap();
  const encoded = JSON.stringify(current);
  if (encoded === bootstrapEncoded) return;
  const known = Boolean(bootstrapEncoded);
  bootstrapEncoded = encoded;
  if (known) for (const stream of streams.values()) stream.publish({ type: "bootstrap", bootstrap: current });
}

function sendState(stream: ClientStream): void {
  const selected = stream.subscription.session;
  const sessions = selected ? stateSnapshot.sessions.map(session => session.id === selected
    ? { ...session, queuedMessages: queuedMessagesFor(selected) } : session) : stateSnapshot.sessions;
  stream.publish({ type: "state", sessions, archivedTotal: stateSnapshot.archivedTotal, ownerErrors: stateSnapshot.ownerErrors });
}

let messagingVersion = -1;
function pushMessaging(target?: ClientStream): void {
  const snapshot = inboxMessaging(messaging.snapshot());
  if (target) { target.publish({ type: "messaging", snapshot }); return; }
  if (snapshot.version === messagingVersion) return;
  messagingVersion = snapshot.version;
  for (const stream of streams.values()) stream.publish({ type: "messaging", snapshot });
}

function sendImages(stream: ClientStream): void {
  const sessionId = stream.subscription.session;
  if (!sessionId) return;
  stream.publish({ type: "images", sessionId, snapshot: inlineImages.snapshot(sessionId) });
}

function sendEvents(stream: ClientStream): void {
  const sessionId = stream.subscription.session;
  const after = stream.subscription.eventsAfter;
  if (!sessionId || after === undefined || after === null) return;
  const events = activity.since(sessionId, after);
  if (!events.length) return;
  stream.subscription.eventsAfter = events.at(-1)!.seq;
  stream.send({ type: "events", sessionId, events });
}

function pushNotifications(target?: ClientStream): void {
  for (const stream of target ? [target] : [...streams.values()]) {
    const cursor = stream.subscription.notificationsAfter;
    if (cursor === undefined || cursor === null) continue;
    const feed = idleNotifications(db, cursor, id => threads.get(id) ?? null);
    if (!feed.notifications.length) continue;
    stream.subscription.notificationsAfter = feed.cursor;
    stream.send({ type: "notifications", feed });
  }
}

function sendLive(stream: ClientStream): void {
  const sessionId = stream.subscription.session;
  if (!sessionId) return;
  const runtime = liveProjections.get(sessionId);
  stream.publish({ type: "live", sessionId, text: runtime?.liveText ?? "",
    ...(stream.subscription.thinking ? { thinking: runtime?.liveThinking ?? "" } : {}) });
}

function pushLive(): void {
  for (const stream of streams.values()) {
    sendLive(stream);
    sendEvents(stream);
  }
}

const transcripts = new TranscriptItems();
const TRANSCRIPT_COALESCE_MS = 100;
const transcriptTimers = new Map<string, ReturnType<typeof setTimeout>>();

function sessionSubscribers(sessionId: string): ClientStream[] {
  return [...streams.values()].filter(stream => stream.subscription.session === sessionId);
}

/** Project a captured context once; the reconciler owns each client's differences. */
function refreshTranscript(sessionId: string) {
  const stored = storedContext(sessionId);
  const display = stored ? displayContext(sessionId, stored.hash, stored.document) : null;
  const update = display ? transcripts.derive(sessionId, display.hash, () => JSON.parse(display.document)) : null;
  for (const stream of sessionSubscribers(sessionId)) sendTranscript(stream, update);
  return update;
}

function signalTranscript(sessionId: string): void {
  if (shuttingDown || transcriptTimers.has(sessionId) || !sessionSubscribers(sessionId).length) return;
  transcriptTimers.set(sessionId, setTimeout(() => {
    transcriptTimers.delete(sessionId);
    refreshTranscript(sessionId);
  }, TRANSCRIPT_COALESCE_MS));
}

function sendTranscript(stream: ClientStream, update: ReturnType<typeof refreshTranscript>): void {
  const sessionId = stream.subscription.session;
  if (!sessionId) return;
  const current = update?.current;
  const from = stream.subscription.transcriptFrom;
  const limit = from == null ? 60 : Math.max(60, (current?.items.length ?? 0) - from);
  stream.publish({ type: "transcript", sessionId, generation: current?.generation ?? "", total: current?.items.length ?? 0,
    items: current ? transcriptWindow(current.items, limit) : [] });
}

/** Apply a subscription change and push whatever it now entitles the client to. */
async function applySubscription(stream: ClientStream, patch: Partial<StreamSubscription>): Promise<void> {
  const before = stream.subscription;
  stream.declare(patch);
  const revision = stream.revision;
  const sessionId = stream.subscription.session ?? null;
  const changedSession = (before.session ?? null) !== sessionId;
  if (sessionId && stream.subscription.viewing) markSessionViewed(sessionId);
  if (sessionId) {
    const captured = storedContext(sessionId);
    if (captured) refreshTranscript(sessionId);
    sendLive(stream);
    sendImages(stream);
    sendEvents(stream);
    if (sessionRow.get(sessionId) && (changedSession || !captured)) {
      void refreshThreadInspection(sessionId).then(() => {
        if (stream.closed || stream.revision !== revision) return;
        refreshTranscript(sessionId);
        sendLive(stream);
      }, cause => {
        if (stream.closed || stream.revision !== revision) return;
        stream.send({ type: "error", message: `Could not refresh thread: ${cause instanceof Error ? cause.message : String(cause)}` });
      });
    } else if (!captured) refreshTranscript(sessionId);
  }
  projectState();
  sendState(stream);
  pushMessaging(stream);
  stream.publish({ type: "bootstrap", bootstrap: bootstrap() });
  if (patch.notificationsAfter !== undefined) pushNotifications(stream);
  if (stream.subscription.dashboard) {
    if (!dashboardSnapshot) await refreshDashboard();
    if (!stream.closed && stream.revision === revision && dashboardSnapshot) stream.publish({ type: "dashboard", dashboard: dashboardSnapshot });
  }
}

function closeStream(stream: ClientStream): void {
  streams.delete(stream.id);
  stream.close();
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
    invalidateDisplayContext(sessionId);
    signalLiveSync();
    return;
  }
  if (event.type === "thread_error") {
    emit(sessionId, "notice", { text: String(event.error) });
    return;
  }
  if (event.type === "context_update") {
    if (event.contextOwner === "remote-mirror") return;
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
    landedWork.forget(sessionId);
    responseTiming.forget(sessionId);
    settleLiveProjection(rt);
    void refreshThreadNotifications();
    emit(sessionId, "settled", { workId: event.workId, outcome: event.outcome }, `settled:${event.executionId}`);
    if (event.outcome === "failed") emit(sessionId, "notice", {
      text: modelFailureText(event.finalMessage) ?? "The thread execution failed",
    }, `failure:${event.executionId}`);
    return;
  }

  if (event.type === "message_start" && event.message?.role === "assistant") responseTiming.start(sessionId);
  if (event.type === "message_update" && ["text_delta", "thinking_delta"].includes(String(event.assistantMessageEvent?.type)))
    responseTiming.firstToken(sessionId);

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
      const displayText = textFromMessage(displayAssistantMessage(event.message));
      if (displayText) rt.liveText = textPrefix + displayText;
      const thinkingPrefix = rt.liveThinking.slice(0, Math.min(rt.pendingContextThinkingLength, rt.liveThinking.length));
      const streamedThinking = rt.liveThinking.slice(thinkingPrefix.length);
      const completedThinking = thinkingFromMessage(event.message) || streamedThinking;
      if (completedThinking) rt.liveThinking = thinkingPrefix + completedThinking;
      const finalization = messageFinalizationKey(event.message);
      recordThinkingEvent(sessionId, completedThinking, finalization);
      recordResponseMetrics(sessionId, responseTiming.finish(sessionId, event.message), finalization);
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
      signalLiveSync();
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
    invalidateDisplayContext(sessionId);
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
    invalidateDisplayContext(sessionId);
    signalLiveSync();
  } else if (event.type === "tool_execution_end") {
    const toolCallId = String(event.toolCallId ?? "");
    rt.activeTools.delete(toolCallId);
    const output = toolResultText(event.result);
    const tool = rt.toolProgress.get(toolCallId);
    if (tool) rt.toolProgress.set(toolCallId, { ...tool, result: {
      content: [{ type: "text", text: output }], timestamp: Date.now(), isError: Boolean(event.isError),
    } });
    invalidateDisplayContext(sessionId);
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
  const family = ORCHESTRATOR_CATALOG.models.find(candidate => candidate.provider === model.provider && candidate.model === model.id)?.id;
  if (family === "fable") return 0;
  if (family === "opus") return 1;
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
  return { ok: true, value: publicSessions(children.map(thread => threadRow(thread))) };
}

async function threadSettings(row: any) {
  const metadata = threadSettingsMetadata(row.settings, threads.get(row.id) ? THREAD_MODEL_CATALOG : undefined);
  return {
    ...metadata,
    bashTimeoutSeconds: bashTimeoutSeconds(row.bash_timeout_seconds),
    models: rolledUpModels(metadata.models),
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

// A turn counts as delivered when this thread's own context contains it. The
// annotations say what was attached; the context says what arrived.
const handoffHistory: HandoffHistory = {
  receipts(sessionId) {
    return (db.query("SELECT meeting_transcript,created_at FROM message_annotations WHERE session_id=? ORDER BY created_at")
      .all(sessionId) as Array<{ meeting_transcript: string; created_at: string | null }>)
      .map(row => ({ transcript: row.meeting_transcript, time: row.created_at ?? "" }));
  },
  messages(sessionId) {
    const stored = storedContext(sessionId);
    if (!stored) return [];
    let messages: any[];
    try { messages = JSON.parse(stored.document).messages ?? []; } catch { return []; }
    return messages.filter((message: any) => message?.role === "user")
      .map((message: any) => ({ text: contentText(message.content), time: Number(message.timestamp) || stored.capturedAt }));
  },
};

async function prepareThreadMessage(thread: Thread, message: ThreadMessage): Promise<Result<{text: string; images?: unknown[]}>> {
  const meetingId = remotePlacement(thread).meetingId;
  if (typeof meetingId !== "string" || !meetingId) return { ok: true, value: { text: message.text, images: message.images } };
  try {
    await meet.flushTranscript(meetingId);
    const transcript = await prepareMeetingHandoff(db, meet.transcripts, meetingId, thread.id, handoffHistory);
    db.query("INSERT OR REPLACE INTO message_annotations(work_id,session_id,created_at,meeting_transcript) VALUES(?,?,?,?)")
      .run(message.id, thread.id, now(), JSON.stringify(transcript));
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
  meetingId: string | null, message?: string, parentId?: string, settings?: Parameters<typeof directory.spawn>[0]["settings"], contextFiles: string[] = []) {
  const admitted = workspaceAdmission.resolve(destination.workspaceId);
  if (!admitted.ok) throw new Error(admitted.error.message);
  const thread = unwrap(await directory.spawn({ id, requestId: id, title: name, parentId,
    cwd: admitted.value.cwd, message, settings: { model, ...settings },
    metadata: { workspaceId: destination.workspaceId, profileId: destination.id, meetingId, ...(destination.raw ? { raw: true } : {}),
      ...(contextFiles.length ? { contextFiles } : {}) },
  }));
  ensureThreadView(db, thread.id);
  return thread;
}
const unsubscribeThreads = threads.subscribe(change => {
  if ("event" in change) handlePiEvent(change.threadId, change.event);
  else { ensureThreadView(db, change.threadId); const thread = threads.get(change.threadId); if (thread) noteModelRecency(thread); signalSync(); }
});
{
  const table = threadTable();
  for (const thread of table.all) { ensureThreadView(db, thread.id); noteModelRecency(thread, table.lookup); }
}
await inlineImages.start();

const meet = new MeetServer((id) => {
  const row = sessionRow.get(id) as any;
  return Boolean(row && !row.archived_at);
}, undefined, db, (meetingId, rootId) => meetingActivity(id => activity.recent(id, ["tool_start", "tool_end", "assistant", "notice"], 8), allThreadRows().filter(row => row.meeting_id === meetingId), rootId, (row) => {
  const runtime = liveProjections.get(row.id);
  return { state: row.state, held: Boolean(row.held),
    activity: threadActivity(row.state, runtime, runningChildParents(threads.snapshot(), peerThreads.values()).has(row.id)),
    tools: [...(runtime?.activeTools.values() ?? [])], output: runtime?.liveText ?? "" };
}));


const messaging = createMessagingService(DATA, PRIVATE_DIR, ENVIRONMENT_REQUIRES_UNLOCK, signalSync);
const AUDIO_SOCKET_BACKPRESSURE_BYTES = 64 * 1024;
type AudioSocketData = { callId: string; audio?: ReturnType<typeof openCallAudio> };
const server = Bun.serve<AudioSocketData>({
  hostname: HOST,
  port: PORT,
  idleTimeout: 30,
  async fetch(req, httpServer) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS" && url.pathname.startsWith("/v1/")) {
      return new Response(null, {
        status: 204,
        headers: { ...API_CORS_HEADERS, "access-control-max-age": "86400" },
      });
    }
    if (!ownsSupervisorLease()) return error("Supervisor instance was replaced", 503);
    if (shuttingDown && !supervisorRelease.accepts(req.method, url.pathname)) return error("Supervisor is handing over; retry after activation", 503);
    const callAudio = req.method === "GET" && req.headers.get("upgrade")?.toLowerCase() === "websocket"
      ? /^\/v1\/messaging\/calls\/([^/]+)\/audio$/.exec(url.pathname)
      : null;
    if (callAudio) {
      let callId: string;
      try { callId = decodeURIComponent(callAudio[1]!); }
      catch { return error("Invalid call id", 400); }
      return httpServer.upgrade(req, { data: { callId } })
        ? undefined
        : error("WebSocket upgrade failed", 400);
    }
    const messagingResponse = await messaging.handle(req);
    if (messagingResponse) return messagingResponse;
    const speechResponse = speech ? await speech.handle(req) : null;
    if (speechResponse) return speechResponse;
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
      const headers = new Headers({ ...API_CORS_HEADERS, "content-type": image.mimeType, "cache-control": "private, max-age=31536000, immutable", etag: `"${imageRequest.hash}"` });
      if (url.searchParams.get("download") === "1") {
        const extension = image.mimeType === "image/jpeg" ? "jpg" : image.mimeType.slice("image/".length);
        headers.set("content-disposition", `attachment; filename="image.${extension}"`);
      }
      if (req.headers.get("if-none-match") === headers.get("etag")) return new Response(null, { status: 304, headers });
      return new Response(Buffer.from(image.data, "base64"), { headers });
    }
    const imagesRequest = API.sessionImages.match(req.method, url.pathname);
    if (imagesRequest) {
      if (!sessionRow.get(imagesRequest.sessionId)) return error("Session not found", 404);
      return json(inlineImages.snapshot(imagesRequest.sessionId));
    }
    const transcriptRequest = API.sessionTranscript.match(req.method, url.pathname);
    if (transcriptRequest) {
      const id = transcriptRequest.sessionId;
      if (!sessionRow.get(id)) return error("Session not found", 404);
      if (!storedContext(id)) await refreshThreadInspection(id);
      const update = refreshTranscript(id);
      if (!update) return json({ sessionId: id, generation: "", total: 0, items: [] });
      const items = update.current.items;
      const generation = url.searchParams.get("generation") ?? "";
      if (generation && generation !== update.current.generation) {
        // The client's window is gone; answer with the one that replaced it.
        return compressedJson(req, { error: "The transcript generation has been replaced", sessionId: id,
          generation: update.current.generation, total: items.length, items: transcriptWindow(items) }, 409);
      }
      const requestedBefore = Number(url.searchParams.get("before") ?? items.length);
      const before = Number.isSafeInteger(requestedBefore) ? requestedBefore : items.length;
      const requestedLimit = Number(url.searchParams.get("limit") ?? 60);
      const limit = Math.min(200, Math.max(1, Number.isSafeInteger(requestedLimit) ? requestedLimit : 60));
      return compressedJson(req, { sessionId: id, generation: update.current.generation, total: items.length,
        items: transcriptPage(items, before, limit) });
    }
    const itemRequest = API.sessionItem.match(req.method, url.pathname);
    if (itemRequest) {
      const id = itemRequest.sessionId;
      if (!sessionRow.get(id)) return error("Session not found", 404);
      let body = transcripts.get(id)?.bodies.get(itemRequest.itemId);
      if (!body) {
        if (!storedContext(id)) await refreshThreadInspection(id);
        body = refreshTranscript(id)?.current.bodies.get(itemRequest.itemId);
      }
      if (!body) return error("Transcript item not found", 404);
      const headers: Record<string, string> = {
        ...API_CORS_HEADERS,
        "content-type": "application/json",
        // The id is the body's hash, so this body can never change.
        "cache-control": "private, max-age=31536000, immutable",
        etag: `"${itemRequest.itemId}"`,
        vary: "accept-encoding",
      };
      if (req.headers.get("if-none-match") === headers.etag) return new Response(null, { status: 304, headers });
      if (body.length >= 1_024 && /(?:^|,)\s*gzip(?:\s*;|\s*,|$)/i.test(req.headers.get("accept-encoding") ?? "")) {
        headers["content-encoding"] = "gzip";
        return new Response(Bun.gzipSync(Buffer.from(body)), { headers });
      }
      return new Response(body, { headers });
    }
    const deliveredFile = await sessionFileResponse(url, req.method, req);
    if (deliveredFile) return deliveredFile;
    if (API.fileDownload.match(req.method, url.pathname) || API.fileDownloadHead.match(req.method, url.pathname)) {
      return localFileResponse(url.searchParams.get("path") ?? "", req.method, req);
    }
    const web = webResponse(WEB_DIR, url.pathname, req.method, req);
    if (web) return web;
    if (API.health.match(req.method, url.pathname)) return json({ ok: true, version: VERSION, environmentId: ENVIRONMENT_ID, releaseCommit: RELEASE_COMMIT });
    if (API.profile.match(req.method, url.pathname)) {
      const seconds = Math.min(60, Math.max(1, Number(url.searchParams.get("seconds")) || 10));
      const report = await profileMainThread(seconds * 1000);
      if (url.searchParams.get("format") === "text") return new Response(formatProfile(report), { headers: { ...API_CORS_HEADERS, "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
      return json(report);
    }
    if (API.loopLag.match(req.method, url.pathname)) return json(await measureLoopLag(Math.min(60, Math.max(1, Number(url.searchParams.get("seconds")) || 5)) * 1000));
    if (API.environment.match(req.method, url.pathname)) return json({ environment: environmentMetadata() });
    if (API.environments.match(req.method, url.pathname)) return json({ environments: [ownEnvironment()] });
    if (API.fileInfo.match(req.method, url.pathname)) {
      const requested = url.searchParams.get("path") ?? "";
      if (!isAbsolute(requested)) return error("Valid absolute path required");
      try { return json({ entry: inspectPath(requested) }); }
      catch (cause) {
        const failure = fileBrowserError(cause);
        return error(failure.status === 404 ? "Path not found" : failure.message, failure.status);
      }
    }
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
      return json({ environmentId: ENVIRONMENT_ID, ...idleNotifications(db, after, id => threads.get(id)) });
    }
    if (API.workspaces.match(req.method, url.pathname)) {
      return json({ workspaces: [...workspaces.values()] });
    }
    if (API.stream.match(req.method, url.pathname)) {
      const patch = readSubscription(await readBody(req).catch(() => ({})));
      let stream!: ClientStream;
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          stream = new ClientStream({
            write: (chunk) => controller.enqueue(encoder.encode(chunk)),
            close: () => { try { controller.close(); } catch {} },
          }, reconciledState);
        },
        cancel: () => { closeStream(stream); },
      });
      streams.set(stream.id, stream);
      // The supervisor's socket idles out after 30 seconds; this connection is
      // meant to stay open, and the comment lines keep proxies convinced too.
      httpServer.timeout(req, 0);
      const ping = setInterval(() => {
        if (stream.closed) { clearInterval(ping); closeStream(stream); return; }
        stream.ping();
      }, PING_INTERVAL_MS);
      req.signal.addEventListener("abort", () => { clearInterval(ping); closeStream(stream); }, { once: true });
      const facts = bootstrap();
      bootstrapEncoded = JSON.stringify(facts);
      stream.send({ type: "hello", epoch: SUPERVISOR_EPOCH, streamId: stream.id, bootstrap: facts });
      void applySubscription(stream, patch).catch((cause) => {
        stream.send({ type: "error", message: cause instanceof Error ? cause.message : String(cause) });
      });
      void refreshPeers();
      return new Response(body, { headers: {
        ...API_CORS_HEADERS,
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        // Buffering proxies would hold events back until the connection ends.
        "x-accel-buffering": "no",
      } });
    }
    const streamUpdate = API.streamUpdate.match(req.method, url.pathname);
    if (streamUpdate) {
      const stream = streams.get(streamUpdate.streamId);
      if (!stream) return error("Unknown stream", 404);
      try {
        await applySubscription(stream, readSubscription(await readBody(req)));
        return new Response(null, { status: 204, headers: API_CORS_HEADERS });
      } catch (cause: any) { return error(cause?.message ?? "Could not update the stream", 400); }
    }
    const errorDismissal = API.dismissError.match(req.method, url.pathname);
    if (errorDismissal) {
      if (dismissError(db, errorDismissal.errorId)) signalSync();
      return json({ ok: true });
    }
    if (API.sessions.match(req.method, url.pathname)) {
      void refreshPeers();
      projectState();
      return json(currentState());
    }
    if (API.archivedSessions.match(req.method, url.pathname)) {
      await refreshPeers();
      const page = archivedSessionPage(url.searchParams);
      return json({ ...page, sessions: publicSessions(page.sessions) });
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
        const contextFiles = selectContextFiles(destinationContextDir(destination), body.contextFiles);
        if (!contextFiles.ok) return error(contextFiles.error);
        const thread = await insertThread(id, creationName(requestId), destination, model, body.meetingId ?? null, body.message, body.parentId,
          { thinkingLevel: body.thinkingLevel, speed: body.speedMode }, contextFiles.value);
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
      ["unarchive", API.unarchiveSession], ["color", API.sessionColor], ["prompt", API.sessionPrompt], ["fork", API.sessionFork], ["abort", API.sessionAbort], ["resume", API.sessionResume],
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
    if (action === "color" && req.method === "PUT") {
      try {
        const body = await readBody(req);
        if (!body || typeof body !== "object" || !("color" in body) || (body.color !== null && !isThreadColor(body.color))) return error("Invalid thread color", 400);
        setThreadColor(db, id, body.color);
        signalSync();
        return json({ ok: true, session: publicSession(sessionRow.get(id)) });
      } catch (cause: any) { return error(cause?.message ?? "Could not update thread color", 400); }
    }
    if (!action && req.method === "PUT") return error("Threads cannot be edited", 405);
    if (!action && req.method === "DELETE") {
      const archived = await closeAiChat(directory, id);
      return archived.ok ? json({ ok: true, archived: true, session: publicSession(threadRow(archived.value)) }) : threadError(archived.error);
    }
    if (row.archived_at && action !== "events" && action !== "context") return error("Thread is archived", 409);
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
        markLandedWork(id, () => JSON.parse(appended.value.document));
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
      const events = activity.since(id, after);
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
      try {
        const result = await updateThreadSettings(directory, row, await readBody(req));
        if (!result.ok) return threadError(result.error);
        return json({ settings: await threadSettings(threadRow(result.value)) });
      } catch (cause: any) { return error(cause?.message ?? "Could not update thread settings", 400); }
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
          if (row.state === "running" || row.pendingMessages) return error("Wait for the thread to become idle before editing", 409);

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
          // The branch changed under the thread: what Voice and the meeting
          // panel were watching no longer describes it.
          activity.forget(id);


          rt.liveText = "";
          rt.liveThinking = "";
          rt.thinkingBlockStart = 0;
          rt.pendingContextTextLength = 0;
          rt.pendingContextThinkingLength = 0;
          rt.pendingContextFinalization = null;
          rt.activeTools.clear();
          rt.thinkingActive = false;
          rt.toolProgress.clear();
          invalidateDisplayContext(id);
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
  websocket: {
    perMessageDeflate: false,
    maxPayloadLength: AUDIO_SOCKET_BACKPRESSURE_BYTES,
    backpressureLimit: AUDIO_SOCKET_BACKPRESSURE_BYTES,
    closeOnBackpressureLimit: false,
    open(socket) {
      const audio = openCallAudio(socket.data.callId);
      if (!audio) {
        socket.close(1008, "Call is unavailable");
        return;
      }
      socket.data.audio = audio;
      if (!audio.attach((frame: Uint8Array) => {
        if (socket.readyState !== WebSocket.OPEN || socket.getBufferedAmount() >= AUDIO_SOCKET_BACKPRESSURE_BYTES) return;
        socket.sendBinary(frame, false);
      }, () => socket.close(1000))) {
        socket.data.audio = undefined;
        audio.detach();
        socket.close(1008, "Call is unavailable");
      }
    },
    message(socket, message) {
      if (typeof message === "string") return;
      const frame = message instanceof Uint8Array ? message : new Uint8Array(message);
      socket.data.audio?.receive(frame);
    },
    close(socket) {
      socket.data.audio?.detach();
      socket.data.audio = undefined;
    },
  },
});
console.log(`Pi Remote listening on http://${server.hostname}:${server.port}`);

// The retired journal's facts moved during startup. Removing what is left is
// slow enough to matter to an activation handshake and to a request in flight,
// and urgent to nobody, so it happens a slice at a time between requests.
const journalRemoval = setInterval(() => {
  try { if (removeEventJournal(db) === "removed") clearInterval(journalRemoval); }
  catch (cause) {
    clearInterval(journalRemoval);
    console.error("[supervisor] could not remove the retired event journal", cause);
  }
}, 200);
journalRemoval.unref?.();

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
const unreadThread = db.query("SELECT idle_unread FROM thread_views WHERE id=?");
const stopAutoArchive = startAutoArchive(directory, AUTO_ARCHIVE_AFTER_MS, error => console.error("[supervisor] auto-archive failed", error), thread => Boolean((unreadThread.get(thread.id) as { idle_unread: number } | null)?.idle_unread));
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

// A naming attempt that failed leaves the thread parked until its next message, which never comes for
// a finished conversation. Starting the supervisor is new evidence — a repaired release, a reachable
// engine, a restored account — so every thread still carrying its number gets one more attempt.
for (const thread of threads.snapshot({ archived: false })) {
  if (unnamedThread(thread.title)) db.query("UPDATE thread_views SET naming_attempted_count=named_at_message_count WHERE id=? AND naming_attempted_count>named_at_message_count").run(thread.id);
}

const uploadPruner = setInterval(pruneUploadTransfers, 60_000);
const namingReceipts = setInterval(reconcileThreadNames, 15_000);
reconcileThreadNames();

const stopThreadRefresh = startThreadRefresh({
  subscriptions: () => [...streams.values()].map(stream => stream.subscription),
  refreshPeers,
  async inspect(id) {
    if (!sessionRow.get(id)) return;
    await refreshThreadInspection(id);
    signalTranscript(id);
  },
  onError: cause => console.error("Thread refresh failed", cause),
});

function stopSupervisorTimers() {
  stopAutoArchive();
  clearInterval(uploadPruner);
  clearInterval(namingReceipts);
  clearInterval(dashboardTicker);
  stopThreadRefresh();
  for (const timer of transcriptTimers.values()) clearTimeout(timer);
  transcriptTimers.clear();
  for (const stream of [...streams.values()]) closeStream(stream);
  stopLedgerSnapshots();
}

async function closeImageGeneration() {
  inlineImages.stop();
  try { await imageProvider?.close(); }
  finally { await inlineImages.close(); }
}

const supervisorRelease = new SupervisorRelease({
  suspend() {
    shuttingDown = true;
    stopSupervisorTimers();
    unsubscribeThreads();
    threads.suspend();
    runner.detach();
  },
  detach: () => threads.detach(),
  closeImages: async () => { speech?.close(); await messaging.close(); await closeImageGeneration(); },
  stopServer: () => { server.stop(true); },
  closeDatabase: () => db.close(),
  exit: code => process.exit(code),
});
async function releaseSupervisor(exitCode: number) {
  const result = await supervisorRelease.release(exitCode);
  if (!result.ok) console.error("Supervisor handoff failed; context ingestion remains available for recovery:", result.error);
}

process.on("SIGTERM", () => void releaseSupervisor(0));
process.on("SIGINT", () => void releaseSupervisor(0));
process.on("SIGUSR2", () => void releaseSupervisor(75));
process.on("SIGHUP", () => void releaseSupervisor(75));
