import { Database } from "bun:sqlite";
import { telephoneDispatcher } from "./phone/dispatcher";
import type { ImageContent } from "@earendil-works/pi-ai";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync, watchFile, unwatchFile } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { configuredOrchestratorThreadUrl } from "./thread-owners";
import { isHostAdministrator, peopleUsage as readPeopleUsage } from "./people-usage";
import { projectThreadNotifications } from "./thread-notifications";
import { startThreadRefresh } from "./thread-refresh";
import { readLivePeers, readPeerAncestors, readPeerSession } from "./peer-directory";
import {
  WatchList,
  watchInterval,
  watchSettings,
  loadThreadModelCatalog,
  threadSettingsMetadata,
  modelBrokerUrl,
  createWorkspaceAdmission,
  ORCHESTRATOR_CATALOG,
  OrchestratorClient,
  catalogAgentType,
  createSharedImageGenerationService,
  resolveDelivery,
  ThreadService,
  configuredPersonSpawnModel,
  configuredAgentCapacity,
  ModelAvailabilityStore,
  modelAvailabilityPath,
  modelAvailabilityKey,
  ThreadDirectory,
  archivedAcrossOwners,
  createThreadClient,
  importRemoteThreads,
  createSharedPiSessionOpener,
  threadHttp,
  admissionFor,
  callerResolver,
  hostIdentityConfig,
  threadCapability,
  type CallerSource,
  type ThreadCreator,
  type ThreadInspection,
  type Thread,
  type ThreadMessage,
  type PiEvent,
  type Result,
  type SharedImageGenerationService,
  type ThreadModeName,
  type PlanUsageSnapshot,
  type PersonalUsage,
  readBrokerUsage,
} from "pi-orchestrator/api";
import { createLiveProjection, settleLiveProjection, restoreLiveProjection, projectThreadActivity, type LiveProjection } from "./live-projection";
import { InlineImages } from "./inline-images";
import { planCards } from "./catalog-presentation";
import { updateThreadSettings } from "./thread-settings";
import { readMachineUsage } from "./machine-usage";
import { readRecentHistoryMessages } from "./recent-history-messages";
import { ThreadTranscriptSource } from "./thread-transcript-source";
import { contextResponse } from "./context-response";
import { RequestTimings } from "./request-timings";
import { updateToolProgress, type ToolProgress } from "./tool-progress";
import { ResponseTiming, type ResponseMetrics } from "./response-metrics";
import { messageFinalizationKey, sha256 } from "./sync";
import { QuestionFeed } from "./question-feed";
import { beginSupervisorGeneration, ensureSupervisorSchema, ensureThreadView, removeEventJournal, setThreadColor, recordIdleNotification } from "./database";
import { oneKenanEnabled } from "kenan-memory/config";
import { lifeClient } from "kenan-memory/life-client";
import type { LifePolicyView, LifeSnapshot } from "kenan-memory/life-contract";
import { projectNeedsYou, readNeedsYouQuestions } from "./needs-you";
import { dismissNeedsYou, parseNeedsYouDismissal } from "./needs-you-dismissal";
import { handleRoomOwner, RoomHistoryError } from "./rooms-owner";
import { roomInput, roomInstructions, roomMetadata, roomMembers } from "../shared/rooms";
import { dismissError, observeError, observeFailure } from "./error-feedback";
import { startLedgerSnapshots } from "./ledger-snapshot";
import { SupervisorRelease } from "./supervisor-release";
import { autoArchiveDelay, startAutoArchive } from "./auto-archive";
import { Manager, managerDestination, managerSettings, parseManagerPatch } from "./manager";
import { createThreadViewRecorder } from "./thread-viewing";
import { VoiceClient } from "./voice/client";
import { MeetGateway } from "./meet/gateway";
import { meetingActivity } from "./meet/activity";
import { SessionActivity } from "./session-activity";
import { observeExecutionActivity, reconcilePersonTimezoneProjection } from "pi-orchestrator/api";
import { meetingHandoffText, prepareMeetingHandoff, type HandoffHistory } from "./meet/handoff";
import { voiceMeetingContext } from "./meet/mention";
import { meetingThreadInstructions } from "./meet/instructions";
import { externalMeetingRequest } from "./meet/external";
import { ensureExternalMeetingThread } from "./meet/threads";
import { liveDevInstructions } from "./skills";
import { configuredThreadDestinations, defaultThreadDestinations, recentThreadModels, threadModelOptions, type ThreadDestination } from "./thread-model-defaults";
import { contextFilesPrompt, listContextFiles, selectContextFiles, watchContextFiles, type ContextFileSources } from "./thread-context-files";
import { API } from "./api";
import { SettingsService, type OwnedSettingAdapter } from "./settings-store";
import { machineActionDefinition, modelAvailabilityDefinition } from "../shared/settings";
import { settingsError } from "pi-orchestrator/person-settings-contract";
import { PhoneBroker, phoneCallerAllowed, type PhoneSocketData } from "./phones";
import { CalendarStore } from "./calendar";
import { PhoneOverlay } from "./phone-overlay";
import { PHONE_MAX_FRAME_BYTES } from "./phone-commands";
import { jsonHttp } from "./json-http";
import { FeatureUsage } from "./feature-usage";
import { createHash } from "node:crypto";
import { parseFeatureEvent, type Feature, type FeatureActor } from "../shared/feature-usage";
import { idleNotifications, notificationHistory, resolveNotificationQuestions } from "./notifications";
import { notificationUnread, humanQuestions } from "./notification-policy";
import { managerRelay } from "./manager-relay";
import { managerRelayClient as createManagerRelayClient } from "./manager-relay-client";
import { listPersons, publicPerson } from "./persons";
import { ownEnvironment } from "./environments";
import { API_CORS_HEADERS } from "./cors";
import { fileBrowserError, inspectPath, localFileResponse, webResponse } from "./files";
import { formatProfile, measureLoopLag, profileMainThread } from "./profiler";
import { BASH_TIMEOUT_OPTIONS, DEFAULT_BASH_TIMEOUT_SECONDS, type AgentModelCount, type BashTimeoutSeconds, type Bootstrap, type Dashboard, type PeopleUsage, type QueuedMessage, type Session, isThreadColor, type StreamSubscription, type StreamWireEvent, type SupervisorState } from "./protocol";
import { fleetSessions, streamSessions } from "./stream-sessions";
import { ClientStream, PING_INTERVAL_MS, readSubscription } from "./stream";
import { ReconcilePublisher } from "../shared/reconcile";
import { parsePresentationEvent } from "./pi-event-presentation";
import { SourceTranscripts, type SourceResult } from "./source-transcripts";
import { refreshTranscriptProjection } from "./transcript-refresh";
import { MachineActions } from "./machine-actions";
import { createMessagingService } from "./messaging";
import { PiReactions, nativeMessageExists, reactToMessage } from "./reactions";
import { parseMessageReference } from "./message-protocol";
import { decodeMessageReply, encodeMessageReply, replyFromNativeEntry } from "./message-replies";
import { PromptAdmissions } from "./prompt-admissions";
import { SlackReactions } from "./slack-reactions";
import { AGENT_NAME } from "./agent-identity";
import { createSpeechService } from "./speech/service";
import { closeAiChat } from "./chat-lifecycle";
import { archivedSessionQuery } from "./archived-sessions";
import { availableUploadPath, storeUpload, uploadName } from "./uploads";

const VERSION = (JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8")) as { version: string }).version;
const ENVIRONMENT_ID = process.env.PI_REMOTE_ENVIRONMENT_ID ?? "local";
const ENVIRONMENT_NAME = process.env.PI_REMOTE_ENVIRONMENT_NAME ?? "Local";
const ENVIRONMENT_REQUIRES_UNLOCK = process.env.PI_REMOTE_REQUIRES_UNLOCK === "true";
if (!/^[a-z][a-z0-9-]{0,31}$/.test(ENVIRONMENT_ID)) throw new Error("PI_REMOTE_ENVIRONMENT_ID must be a stable lowercase identifier");
const SUPERVISOR_EPOCH = crypto.randomUUID();
const HOME = homedir();
const MESSAGE_OWNER = { id: process.env.PI_REMOTE_SENDER_ID || userInfo().username, name: process.env.PI_REMOTE_SENDER_NAME || process.env.PI_REMOTE_SENDER_ID || userInfo().username };
const ROOMS_ENABLED = oneKenanEnabled();
const DATA = process.env.PI_REMOTE_DATA ?? join(process.env.XDG_STATE_HOME ?? join(HOME, ".local/state"), "pi-remote");
process.env.PI_PERSON_SETTINGS_DATA = DATA;
const INGESTION = process.env.PI_REMOTE_INGESTION ?? join(DATA, "ingestion");
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

const THREAD_MODEL_CATALOG = await loadThreadModelCatalog(AGENT_DIR);
const THREAD_MODELS = threadModelOptions(THREAD_MODEL_CATALOG.configuredModels);
const modelAvailability = new ModelAvailabilityStore(modelAvailabilityPath());
function availableThreadModels() {
  const policy = modelAvailability.disabled();
  observeError(db, "model-availability", policy.ok ? null : policy.error.message);
  const offered = new Set([...THREAD_DESTINATIONS.values()].flatMap(destination => destination.models));
  return [...new Map([...THREAD_MODELS.values()].filter(model => offered.has(model.id)).map(model => [model.id, model])).values()]
    .map(model => ({ id: model.id, label: model.label, icon: model.icon, accent: model.accent,
      enabled: policy.ok && !policy.value.has(modelAvailabilityKey(`${model.provider}/${model.modelId}`)) }));
}
const OFFERED_DESTINATIONS = (process.env.PI_REMOTE_DESTINATIONS ?? "home").split(",").map((id) => id.trim()).filter(Boolean);
const destinationDefinitions: ThreadDestination[] = process.env.PI_REMOTE_THREAD_DESTINATIONS === undefined
  ? defaultThreadDestinations()
  : JSON.parse(process.env.PI_REMOTE_THREAD_DESTINATIONS);
const THREAD_DESTINATIONS = new Map(configuredThreadDestinations(destinationDefinitions
  .filter((destination) => OFFERED_DESTINATIONS.includes(destination.id)), THREAD_MODEL_CATALOG.configuredModels)
  .map((destination) => [destination.id, destination]));

const machineActions = new MachineActions();
const speech = createSpeechService();

/** Optional context is owned by the destination's workspace and the supervisor's Unix account. */
function destinationContextSources(destination: ThreadDestination | undefined): ContextFileSources | null {
  if (!destination || destination.raw || destination.sandbox) return null;
  const workspace = workspaces.get(destination.workspaceId);
  if (!workspace) return null;
  const personal = destination.id === "personal";
  if (!destination.contextDir && !personal) return null;
  return {
    ...(destination.contextDir ? { directory: resolve(workspace.path, destination.contextDir) } : {}),
    ...(personal ? { agentsPaths: [...new Set([join(workspace.path, "AGENTS.md"), join(HOME, "AGENTS.md")])] } : {}),
  };
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
  const enabled = new Set(availableThreadModels().filter(model => model.enabled).map(model => model.id));
  return [...THREAD_DESTINATIONS.values()].map((destination) => {
    const contextSources = destinationContextSources(destination);
    return {
      id: destination.id,
      label: destination.label,
      icon: destination.icon,
      accent: destination.accent,
      defaultModel: destination.defaultModel,
      models: recentThreadModels(destination, history, THREAD_MODELS).filter(id => enabled.has(id)).map((id) => {
        const model = THREAD_MODELS.get(id);
        if (!model) throw new Error(`Unknown thread model ${id} in profile ${destination.id}`);
        return { id: model.id, label: model.label, icon: model.icon, accent: model.accent };
      }),
      ...(contextSources ? { contexts: listContextFiles(contextSources) } : {}),
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
const transcriptSource = new ThreadTranscriptSource(db, (id, options) => directory.inspect(id, options),
  id => liveProjections.get(id)?.toolProgress, identity => piReactions.list(identity));
const transcripts = new SourceTranscripts(db, transcriptSource.read, transcriptSource.project,
  (sessionId, hash) => API.sessionImage.path({ sessionId, hash }), id => {
    const thread = liveThread(id);
    return thread?.agentName ?? (typeof thread?.metadata?.agentName === "string" ? thread.metadata.agentName : undefined);
  });
const piReactions = new PiReactions(db, MESSAGE_OWNER);
const slackReactions = new SlackReactions(process.env.PI_REMOTE_SLACK_REACTIONS);
const orchestrator = new OrchestratorClient({
  ledgerPath: ORCHESTRATOR_DB_PATH,
});
const voice = new VoiceClient(DATA);
const liveProjections = new Map<string, LiveProjection>();
/** Live timing of the response each session is streaming right now. */
const responseTiming = new ResponseTiming();
const activity = new SessionActivity(() => now());
const forkingSessions = new Set<string>();
let shuttingDown = false;
const runner = createSharedPiSessionOpener({ dataDir: DATA });
// Thread capabilities and caller checks: a thread's parent and creator are verified, never taken from the request.
const capability = threadCapability();
const callers = callerResolver({ capability, host: hostIdentityConfig() });
const MANAGER_ENVIRONMENT_ID = process.env.PI_REMOTE_MANAGER_ENVIRONMENT ?? ENVIRONMENT_ID;
if (!/^[a-z][a-z0-9-]{0,31}$/.test(MANAGER_ENVIRONMENT_ID)) throw new Error("PI_REMOTE_MANAGER_ENVIRONMENT must be an environment ID");
function managerRelayClient(environmentId?: string) {
  return createManagerRelayClient(`http://127.0.0.1:${process.env.PI_REMOTE_ROUTER_PORT ?? "8788"}/v1/agent-manager`, environmentId);
}
const managerOwner = MANAGER_ENVIRONMENT_ID !== ENVIRONMENT_ID ? managerRelayClient() : null;
let manager: Manager | null = null;
let remoteNotificationPolicy: import("pi-orchestrator/api").ManagerNotificationPolicy | null = null;
function currentNotificationPolicy(): import("pi-orchestrator/api").ManagerNotificationPolicy | null {
  if (!manager) return remoteNotificationPolicy;
  const snapshot = manager.snapshot();
  return snapshot.view === "classic" ? { view: "classic" } : { view: "mono", managerThreadId: snapshot.managerThreadId };
}
let notificationPolicyRefresh: Promise<import("pi-orchestrator/api").Result<import("pi-orchestrator/api").ManagerNotificationPolicy>> | null = null;
async function loadNotificationPolicy(): Promise<import("pi-orchestrator/api").Result<import("pi-orchestrator/api").ManagerNotificationPolicy>> {
  if (manager) return { ok: true, value: currentNotificationPolicy()! };
  if (!managerOwner) return { ok: false, error: { code: "unavailable", message: "Canonical manager notification owner is unavailable" } };
  if (notificationPolicyRefresh) return notificationPolicyRefresh;
  notificationPolicyRefresh = managerOwner.managerNotificationPolicy().then(result => {
    const next = result.ok ? result.value : null;
    if (JSON.stringify(remoteNotificationPolicy) !== JSON.stringify(next)) { remoteNotificationPolicy = next; signalSync(); }
    return result;
  }).finally(() => { notificationPolicyRefresh = null; });
  return notificationPolicyRefresh;
}
const threads = new ThreadService({
  managerNotificationPolicy: loadNotificationPolicy,
  ...(managerOwner ? { routeManagerQuestionCustody: input => managerOwner.managerQuestionCustody(input) } : {}),
  capability,
  capacity: configuredAgentCapacity(),
  spawnDefaultModel: () => configuredPersonSpawnModel(),
  admitNewThread: settings => modelAvailability.admit(settings.model),
  attachSession: runner.attachSession,
  recoverSession: runner.recoverSession,
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
const featureUsage = new FeatureUsage(db);
function trackFeature(feature: Feature, actor: FeatureActor, id: string = crypto.randomUUID()) {
  const result = featureUsage.record({ id: createHash("sha256").update(`${feature}:${actor}:${id}`).digest("hex"), feature, kind: "use" }, actor);
  if (!result.ok) observeError(db, "feature-usage", result.error.message);
  return result;
}
const promptAdmissions = new PromptAdmissions(db);
beginSupervisorGeneration(db, SUPERVISOR_EPOCH);
const fleetUrl = process.env.PI_REMOTE_ROOMS_RUNTIME === "1" ? null : configuredOrchestratorThreadUrl();
const fleet = fleetUrl ? createThreadClient(`${fleetUrl}/v1/thread-owner`) : null;
/** Assigned once the phone broker exists; thread events can arrive earlier. */
let phoneOverlay: PhoneOverlay | null = null;
const directory = new ThreadDirectory({ id: "person", api: threads }, fleet ? [{ id: "fleet", api: fleet }] : [], managerOwner ? { id: "manager", api: managerOwner } : undefined, id => {
  const route = db.query("SELECT value FROM metadata WHERE key=?").get(`manager-origin:${id}`) as { value: string } | null;
  return route ? { id: `question-origin:${route.value}`, api: managerRelayClient(route.value) } : null;
});
threads.setDirectory(directory, (parent, input) => {
  // Encrypted-folder sessions must retain their mount namespace and transcript custody.
  const privatePath = (path: string) => resolve(path) === resolve(PRIVATE_DIR) || resolve(path).startsWith(`${resolve(PRIVATE_DIR)}/`);
  return privatePath(parent.cwd) || privatePath(input.cwd) ? undefined : fleet ?? undefined;
});
// Each watch item is checked in the destination it came from, with that destination's chosen context.
const WATCH_DESTINATIONS = [...THREAD_DESTINATIONS.values()].filter(destination => !destination.raw && !destination.sandbox).map(destination => destination.id);
const DEFAULT_WATCH_DESTINATION = process.env.PI_REMOTE_WATCH_DESTINATION
  ?? (WATCH_DESTINATIONS.includes("home") ? "home" : WATCH_DESTINATIONS[0] ?? "home");
const watchList = new WatchList({
  databasePath: join(DATA, "threads.sqlite3"), threads,
  intervalMs: watchInterval(process.env.PI_REMOTE_WATCH_INTERVAL_MS),
  settings: unwrap(watchSettings(process.env.PI_REMOTE_WATCH_MODEL)),
  checkOutcome: id => threads.watchCheckOutcome(id),
  enabled: process.env.PI_REMOTE_WATCH_ENABLED !== "0",
  destinations: WATCH_DESTINATIONS,
  defaultDestination: DEFAULT_WATCH_DESTINATION,
  destinationOf: threadId => {
    const thread = threads.get(threadId);
    const profileId = thread ? remotePlacement(thread, id => threads.get(id)).profileId : undefined;
    return typeof profileId === "string" ? profileId : undefined;
  },
  placement: profileId => {
    const destination = THREAD_DESTINATIONS.get(profileId);
    if (!destination || destination.sandbox || destination.raw) return { ok: false, error: { code: "invalid_request", message: `Watch destination ${profileId} must be an offered full-context destination` } };
    const admitted = workspaceAdmission.resolve(destination.workspaceId);
    const contextFiles = watchContextFiles(destination.watchContextFiles, destinationContextSources(destination)?.directory);
    return admitted.ok ? { ok: true, value: { cwd: admitted.value.cwd, metadata: { workspaceId: destination.workspaceId, profileId, ...(contextFiles.length ? { contextFiles } : {}) } } }
      : { ok: false, error: { code: "unavailable", message: admitted.error.message } };
  },
  onError: error => { observeError(db, "watch-list", error); if (error) console.error("Watch list check failed:", error); },
});
threads.setWatchList(watchList);
const MANAGER_DESTINATION = MANAGER_ENVIRONMENT_ID === ENVIRONMENT_ID
  ? unwrap(managerDestination([...THREAD_DESTINATIONS.values()], process.env.PI_REMOTE_MANAGER_DESTINATION)) : null;
manager = MANAGER_DESTINATION ? new Manager(db, threads, () => {
  const admitted = workspaceAdmission.resolve(MANAGER_DESTINATION.workspaceId);
  if (!admitted.ok) return { ok: false, error: { code: "unavailable", message: admitted.error.message } };
  const sources = destinationContextSources(MANAGER_DESTINATION);
  const selected = selectContextFiles(sources, watchContextFiles(MANAGER_DESTINATION.managerContextFiles, sources?.directory));
  return selected.ok ? { ok: true, value: { cwd: admitted.value.cwd, metadata: {
    workspaceId: MANAGER_DESTINATION.workspaceId, profileId: MANAGER_DESTINATION.id, contextFiles: selected.value,
  } } } : { ok: false, error: { code: "invalid_request", message: selected.error } };
}, unwrap(managerSettings(process.env.PI_REMOTE_MANAGER_MODEL)), () => { signalSync(); void refreshThreadNotifications(); void pushNotifications(); }) : null;
if (manager) {
  const workObserver = managerRelayClient();
  threads.setManagerWatchdog(async () => {
    const managerThreadId = manager!.snapshot().managerThreadId;
    if (managerThreadId === null) return { ok: true, value: { managerThreadId, activeWork: false, lastHumanMessageAt: null } };
    const summary = await workObserver.managerWorkSummary();
    return summary.ok ? { ok: true, value: { ...summary.value, managerThreadId } } : summary;
  }, message => { observeError(db, "manager-watchdog", message); });
}
const peerThreads = new Map<string, Thread>();
let peerArchivedTotal = 0;
const peerChildren = new Map<string, boolean>();
const peerInspections = new Map<string, ThreadInspection>();
let peerError: string | null = null;
let peerRecovery: "automatic" | "required" = "automatic";
class PeerOwnershipError extends Error {}
function peerFeedback(message: string | null) {
  return observeFailure(db, "peer:fleet", !message ? null : peerRecovery === "required" ? {
    message, recovery: "required", impact: "Worker status cannot be reconciled because a thread has conflicting owners.",
    action: "Ask Kenan to repair the conflicting thread ownership.",
  } : {
    message, recovery: "automatic", impact: "Worker status updates are delayed; the last available listing is retained.", attentionAfterMs: 60_000,
  });
}
function notificationFeedback(owner: string, message: string | null) {
  return observeFailure(db, `notifications:${owner}`, message ? {
    message, recovery: "automatic", impact: "Idle notifications are delayed; existing notifications are retained.", attentionAfterMs: 60_000,
  } : null);
}
const notificationErrors = new Map<string, string>();
let peerRefresh: Promise<void> | null = null;
const notificationRefreshes = new Map<string, Promise<void>>();
const notificationRefreshAgain = new Set<string>();
function refreshThreadNotifications(cause: "read" | "change" = "change"): Promise<void> {
  return Promise.all(directory.owners.map(owner => {
    const existing = notificationRefreshes.get(owner.id);
    if (existing) { if (cause === "change") notificationRefreshAgain.add(owner.id); return existing; }
    const refresh = (async () => {
      try {
        do {
          notificationRefreshAgain.delete(owner.id);
          const policy = await directory.managerNotificationPolicy();
          if (!policy.ok) throw new Error(policy.error.message);
          await projectThreadNotifications(db, owner.id, owner.api, directory, () => { signalSync(); pushNotifications(); }, policy.value);
        } while (notificationRefreshAgain.has(owner.id));
        notificationFeedback(owner.id, null);
        if (notificationErrors.delete(owner.id)) signalSync();
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        notificationFeedback(owner.id, message);
        if (notificationErrors.get(owner.id) !== message) { notificationErrors.set(owner.id, message); signalSync(); }
      } finally {
        notificationRefreshes.delete(owner.id);
        signalSync(); pushNotifications();
      }
    })();
    notificationRefreshes.set(owner.id, refresh);
    return refresh;
  })).then(() => {});
}
async function refreshPeers() {
  if (!fleet) return;
  if (peerRefresh) return peerRefresh;
  peerRefresh = (async () => {
    const loaded = await readLivePeers(fleet, id => threads.get(id), peerThreads);
    if (!loaded.ok) {
      if (loaded.error.code === "conflict") throw new PeerOwnershipError(loaded.error.message);
      peerRecovery = "automatic"; peerError = loaded.error.message; peerFeedback(peerError); signalSync(); return;
    }
    const next = new Map([...peerThreads].filter(([, thread]) => thread.metadata?.archived));
    for (const [id, thread] of loaded.value.threads) next.set(id, thread);
    const changed = peerError !== null || peerArchivedTotal !== loaded.value.archivedTotal || JSON.stringify([...next]) !== JSON.stringify([...peerThreads]);
    peerArchivedTotal = loaded.value.archivedTotal;
    peerError = null;
    peerFeedback(null);
    const updated = [...next.values()].filter(thread => peerThreads.get(thread.id)?.revision !== thread.revision);
    for (const thread of updated) if (!peerThreads.has(thread.id)) ensureThreadView(db, thread.id);
    peerThreads.clear();
    peerChildren.clear();
    for (const thread of next.values()) if (thread.parentId) peerChildren.set(thread.parentId, true);
    for (const [id, thread] of next) peerThreads.set(id, thread);
    const lookup = cachedThreadLookup(next, id => threads.get(id) ?? null);
    for (const thread of updated) noteModelRecency(thread, lookup);
    if (changed) { signalSync(); void refreshThreadNotifications(); }
  })().catch(cause => {
    const message = cause instanceof Error ? cause.message : String(cause);
    peerRecovery = cause instanceof PeerOwnershipError ? "required" : "automatic";
    peerFeedback(message);
    peerError = message;
    signalSync();
  }).finally(() => { peerRefresh = null; });
  return peerRefresh;
}
const inspectingThreads = new Map<string, Promise<void>>();
async function refreshThreadInspection(id: string, fresh = false) {
  const pending = inspectingThreads.get(id);
  if (pending) return pending;
  const local = threads.get(id);
  const known = peerInspections.get(id);
  const listed = peerThreads.get(id);
  if (!fresh && !local && known && listed?.state === "idle" && known.thread.revision === listed.revision) return;
  const operation = inspectThread(id, Boolean(local)).finally(() => inspectingThreads.delete(id));
  inspectingThreads.set(id, operation);
  return operation;
}
async function inspectThread(id: string, local: boolean) {
  const result = await directory.inspect(id, { context: "omit" });
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
  if (inspection.live) {
    const live = liveFor(id);
    const previous = JSON.stringify([live.activity, live.activitySince, live.lastActivityAt, live.activityDetail, [...live.activeTools]]);
    restoreLiveProjection(live, inspection.live);
    if (previous !== JSON.stringify([live.activity, live.activitySince, live.lastActivityAt, live.activityDetail, [...live.activeTools]])) {
      signalSync();
      signalLiveSync();
    }
  }
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
/** Everyone's relative usage, computed only for the host's administrator. */
const HOST_ADMINISTRATOR = isHostAdministrator();
const settingsService = new SettingsService(DATA, HOST_ADMINISTRATOR, () => {
  if (!HOST_ADMINISTRATOR) return [];
  const adapters: OwnedSettingAdapter[] = availableThreadModels().map(option => ({
    definition: modelAvailabilityDefinition(option.id, option.label, modelAvailability.path),
    read: async () => {
      const policy = modelAvailability.disabled();
      const model = THREAD_MODELS.get(option.id);
      if (!policy.ok) return settingsError("unavailable", policy.error.message);
      if (!model) return settingsError("unknown-setting", "Model no longer configured");
      return { ok: true, value: !policy.value.has(modelAvailabilityKey(`${model.provider}/${model.modelId}`)) };
    },
    write: async value => {
      if (typeof value !== "boolean") return settingsError("invalid", "Model availability requires a boolean");
      const model = THREAD_MODELS.get(option.id);
      if (!model) return settingsError("unknown-setting", "Model no longer configured");
      const saved = modelAvailability.set(`${model.provider}/${model.modelId}`, value);
      if (!saved.ok) return settingsError("unavailable", saved.error.message);
      signalSync(); pushBootstrap(); await refreshDashboard();
      return { ok: true, value };
    },
  }));
  for (const action of machineActions.actions) adapters.push({
    definition: machineActionDefinition(action.id, action.label),
    read: async () => {
      try { return { ok: true, value: (await machineActions.status(action)).active }; }
      catch (cause) { return settingsError("unavailable", String(cause)); }
    },
    write: async value => {
      if (typeof value !== "boolean") return settingsError("invalid", "Machine action requires a boolean");
      try {
        const state = await machineActions.set(action, value);
        await refreshDashboard(); return { ok: true, value: state.active };
      } catch (cause) { return settingsError("unavailable", String(cause)); }
    },
  });
  return adapters;
});
let peopleUsage: PeopleUsage | null = null;
/** The viewer's own spending per plan; null when nothing attributes usage to her. */
let ownUsage: PersonalUsage | null = null;
/** The viewer's weekly spending limit, as her model broker enforces it. */
let allowance: Dashboard["allowance"] = null;
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
    // The administrator's own ledger holds the pool and her spending. Everyone
    // else's ledger is empty; her broker knows the pool and what she spent.
    const broker = HOST_ADMINISTRATOR ? undefined : modelBrokerUrl();
    if (broker) {
      try {
        const usage = await readBrokerUsage(broker);
        planUsage = usage.plans;
        ownUsage = usage.personal;
        allowance = usage.allowance ?? null;
      } catch (cause) {
        console.error("Model broker usage refresh failed", cause);
        planUsage ??= orchestrator.plans();
      }
    } else {
      planUsage = orchestrator.plans();
      if (HOST_ADMINISTRATOR) ownUsage = orchestrator.ownUsage();
    }
    if (HOST_ADMINISTRATOR) {
      try {
        const names = new Map(listPersons().map((person) => [person.user, person.displayName]));
        peopleUsage = readPeopleUsage((windowMs) => orchestrator.personUsage(windowMs), userInfo().username, names);
      } catch (cause) {
        console.error("People usage refresh failed", cause);
      }
    }
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

let imageProvider: SharedImageGenerationService | undefined;
const inlineImages = new InlineImages(db, join(DATA, "inline-images"), async (input, signal) => {
  try {
    imageProvider ??= createSharedImageGenerationService({ ledgerPath: ORCHESTRATOR_DB_PATH });
    return await imageProvider.generateImageWithSharedAccount(input, { signal });
  } catch (cause) {
    return { ok: false, error: { message: cause instanceof Error ? cause.message : String(cause) } };
  }
}, signalSync, 2, ownsSupervisorLease, id => liveThread(id)?.metadata?.sandbox !== true);

/** Live event streams by id, the only thing a client keeps open. */
const streams = new Map<string, ClientStream>();
const reconciledState = new ReconcilePublisher({ maxHistoryPerResource: 32 });

// Anything that can change the inbox projection, the messaging snapshot or a
// client's images calls this. The projection is rebuilt once per burst, and a
// stream only hears about it when its own rows differ.
const STATE_COALESCE_MS = 25;
let statePushTimer: ReturnType<typeof setTimeout> | null = null;
let stateSyncPhase: "initializing" | "ready" = "initializing";
let stateSyncPending = false;
function signalSync() {
  if (shuttingDown) return;
  if (stateSyncPhase === "initializing") { stateSyncPending = true; return; }
  if (statePushTimer) return;
  statePushTimer = setTimeout(() => {
    statePushTimer = null;
    if (!shuttingDown) refreshState();
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
    plans: planCards(planUsage, ownUsage),
    actions: HOST_ADMINISTRATOR ? actions : [],
    machine: readMachineUsage(),
    modelCounts: agents.models,
    ...(HOST_ADMINISTRATOR ? { modelAvailability: availableThreadModels(), canManageModels: true } : {}),
    people: peopleUsage,
    allowance,
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
watchFile(modelAvailability.path, { persistent: false, interval: 1_000 }, () => {
  signalSync();
  if (!shuttingDown && dashboardSubscribers()) void refreshDashboard();
});
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
  if (shuttingDown) return;
  if (liveSyncTimer) {
    liveSyncPending = true;
    return;
  }
  pushLive();
  liveSyncTimer = setTimeout(() => {
    liveSyncTimer = null;
    if (liveSyncPending && !shuttingDown) {
      liveSyncPending = false;
      signalLiveSync();
    }
  }, LIVE_SYNC_INTERVAL_MS);
}

function sourceValue<T>(result: SourceResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function invalidateDisplayContext(sessionId: string) {
  signalTranscript(sessionId);
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
  return meetingThreadInstructions(thread.metadata?.liveDispatcher === true ? "root" : "worker");
}

/** The chosen context files of a thread, whole, for its system prompt. Children do not inherit their parent's choice. */
function chosenContextFiles(sessionId: string): string {
  const thread = threads.get(sessionId);
  const names = thread?.metadata?.contextFiles;
  if (!Array.isArray(names) || !names.length) return "";
  const sources = destinationContextSources(THREAD_DESTINATIONS.get(String(thread!.metadata!.profileId ?? "")));
  return contextFilesPrompt(sources, names.filter((name): name is string => typeof name === "string"));
}

function threadInstructions(sessionId: string, audience: "thread" | "voice" = "thread"): string {
  const snapshot = inlineImages.snapshot(sessionId);
  const registry = snapshot.images.map(({ id, state, refs, path, paths, error, conflict }) => ({ id, state, refs, path, paths, error, conflict }));
  return [
    audience === "thread" && threads.get(sessionId)?.metadata?.manager === true ? readFileSync(join(import.meta.dir, "manager-prompt.md"), "utf8") : "",
    audience === "thread" ? chosenContextFiles(sessionId) : "",
    meetingInstructions(sessionId, audience),
    ROOMS_ENABLED ? roomInstructions(threads.get(sessionId)?.metadata?.room) : "",
    registry.length ? `Pi Remote image registry: ${JSON.stringify({ version: snapshot.version, images: registry })}` : "",
    piReactions.session(sessionId).size ? `Message reactions, keyed by stable message ID: ${JSON.stringify(Object.fromEntries(piReactions.session(sessionId)))}` : "",
    slackReactions.instructions(),
  ].filter(Boolean).join("\n\n");
}

async function voiceInstructions(row: any): Promise<string> {
  const history = sourceValue(await readRecentHistoryMessages(directory.inspect, row.id, 8, contentText))
    .map((message) => `${message.role === "user" ? "User" : "Agent"}: ${message.text.slice(0, 1_500)}`)
    .join("\n");
  const policy = readFileSync(new URL("./voice/delegation-policy.md", import.meta.url), "utf8").trim();
  const instructions = [
    policy,
    `Connected Pi thread: ${JSON.stringify({ id: row.id, name: row.name, meeting: Boolean(row.meeting_id) })}`,
    threadInstructions(row.id, "voice"),
    history ? `Recent thread transcript:\n${history}` : "",
  ].filter(Boolean).join("\n\n");
  // Meeting Voice opens on demand, so it starts without having heard the room; the recent transcript fills that in when it fits the Voice service's 32 kB bound.
  const meeting = row.meeting_id && meet.transcripts.has(row.meeting_id) ? voiceMeetingContext(meet.transcripts.read(row.meeting_id), Date.now()) : "";
  const withMeeting = meeting ? `${instructions}\n\n${meeting}` : instructions;
  return Buffer.byteLength(withMeeting, "utf8") <= 30_000 ? withMeeting : instructions;
}

type ThreadLookup = (id: string) => Thread | null;
function cachedThreadLookup(known: ReadonlyMap<string, Thread>, read: ThreadLookup): ThreadLookup {
  const missing = new Map<string, Thread | null>();
  return id => {
    const thread = known.get(id);
    if (thread) return thread;
    if (!missing.has(id)) missing.set(id, read(id));
    return missing.get(id)!;
  };
}
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
interface ThreadView { id: string; idle_unread: number; color: Session["color"] }
const threadViewRow = db.query("SELECT id,idle_unread,color FROM thread_views WHERE id=?");
const threadViewRows = db.query("SELECT id,idle_unread,color FROM thread_views");
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
  const lookup = cachedThreadLookup(byId, id => threads.get(id) ?? null);
  const views = new Map((threadViewRows.all() as ThreadView[]).map(view => [view.id, view]));
  const peers = [...peerThreads.values()].filter(thread => options.archived !== false || !thread.metadata?.archived);
  const all = [...local, ...peers];
  return { local, all, lookup, rows: () => all.map(thread => threadRow(thread, lookup, views.get(thread.id) ?? null)) };
}
function threadRow(thread: Thread, lookup: ThreadLookup = liveThread, view: ThreadView | null = threadViewRow.get(thread.id) as ThreadView | null): any {
  const meta = { ...remotePlacement(thread, lookup), ...thread.metadata };
  const [provider, ...modelParts] = (thread.effectiveSettings ?? thread.settings).model.split("/");
  const model = { provider, modelId: modelParts.join("/") };
  return { ...thread, name: thread.title, workspace_id: meta.workspaceId ?? thread.cwd,
    session_path: thread.sessionFile,
    initial_model: model?.modelId ?? thread.settings.model, current_provider: model?.provider ?? "",
    initial_provider: model?.provider ?? "", initial_thinking: thread.settings.thinkingLevel,
    meeting_id: meta.meetingId ?? null, profile_id: meta.profileId ?? "home",
    service_tier: thread.settings.speed === "standard" ? "default" : thread.settings.speed,
    bash_timeout_seconds: meta.bashTimeoutSeconds ?? DEFAULT_BASH_TIMEOUT_SECONDS,
    archived_at: meta.archived ? meta.archivedAt ?? new Date(thread.updatedAt).toISOString() : null,
    idle_unread: view?.idle_unread ?? 0,
    color: view?.color ?? null,
    created_at: new Date(thread.createdAt).toISOString(), updated_at: new Date(thread.updatedAt).toISOString() };
}
const sessionRow = { get(id: string) { const found = threads.get(id) ?? peerThreads.get(id); return found ? threadRow(found) : null; } };
function allThreadRows() { return threadTable().rows(); }
const activeSessionRows = { all: () => threadTable({ archived: false }).rows().filter(row => !row.archived_at) };
async function archivedSessionPage(params = new URLSearchParams()) {
  const query = archivedSessionQuery(params);
  const owners = query.conversationsOnly || !fleet ? [threads] : [threads, fleet];
  const result = await archivedAcrossOwners(owners, query);
  if (!result.ok) return result;
  if (result.value.kind !== "page") return { ok: false as const, error: { code: "unavailable" as const, message: "The archive owner did not return a page" } };
  const selected = result.value.threads;
  if (fleet) {
    const ancestors = await readPeerAncestors(fleet, selected.filter(thread => !threads.get(thread.id)), id => threads.get(id), peerThreads);
    if (!ancestors.ok) return ancestors;
    for (const [id, thread] of ancestors.value) { peerThreads.set(id, thread); ensureThreadView(db, id); }
  }
  const lookup = cachedThreadLookup(new Map(selected.map(thread => [thread.id, thread])), liveThread);
  const sessions = publicSessions(selected.map(thread => threadRow(thread, lookup)));
  return { ok: true as const, value: { sessions, total: result.value.total, offset: query.offset, limit: query.limit,
    hasMore: query.offset + sessions.length < result.value.total } };
}

const supervisorEpochRow = db.query("SELECT value FROM metadata WHERE key='supervisor_epoch'");
function ownsSupervisorLease(): boolean {
  try { return (supervisorEpochRow.get() as any)?.value === SUPERVISOR_EPOCH; }
  catch { return false; }
}

// One step of visible work. Voice and the meeting panel watch this window;
// Conversation history belongs to the native transcript.
function emit(sessionId: string, type: string, payload: Record<string, unknown> = {}, receiptId: string | null = null): number {
  if (!ownsSupervisorLease()) return 0;
  const seq = activity.add(sessionId, type, payload, receiptId);
  if (!seq) return 0;
  signalSync();
  // Deliver with the next live frame rather than waiting for the thread's
  // state to move.
  signalLiveSync();
  return seq;
}

function recordMessageFact(sessionId: string, finalizesMessage: string, column: "metrics", value: string) {
  ensureThreadView(db, sessionId);
  db.query(`INSERT INTO message_facts(session_id,finalizes_message,${column}) VALUES(?,?,?)
    ON CONFLICT(session_id,finalizes_message) DO UPDATE SET ${column}=excluded.${column}`)
    .run(sessionId, finalizesMessage, value);
}

function recordResponseMetrics(sessionId: string, metrics: ResponseMetrics | null, finalizesMessage: string) {
  if (!ownsSupervisorLease() || !metrics) return;
  invalidateDisplayContext(sessionId);
  recordMessageFact(sessionId, finalizesMessage, "metrics", JSON.stringify(metrics));
  signalSync();
}

function touchSession(_id: string) { signalSync(); }
const recordThreadView = createThreadViewRecorder(directory, liveThread, thread => {
  if (!threads.get(thread.id)) peerThreads.set(thread.id, thread);
});
async function markSessionViewed(id: string, reopened = false) {
  await recordThreadView(id, reopened);
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
  for (const row of activeSessionRows.all()) if (row.state === "running") {
    running++; addAgentModel(models, (row.effectiveSettings ?? row.settings).model);
  }
  return { running, models: sortedAgentModels(models) };
}

// The inbox projection. Archived threads live behind `/v1/sessions/archived`
// and the messaging inbox travels as its own event, so this is only what every
// client's thread list needs.
function supervisorState(): SupervisorState {
  const table = threadTable({ archived: false });
  return {
    sessions: publicSessions(table.rows().filter(row => !row.archived_at), table.local),
    archivedTotal: threads.archivedCount() + peerArchivedTotal,
    ownerErrors: [
      { owner: "fleet", feedback: peerFeedback(peerError) },
      ...[...notificationErrors].map(([owner, message]) => ({ owner, feedback: notificationFeedback(owner, message) })),
    ].flatMap(({ owner, feedback }) => feedback ? [{ owner, ...feedback }] : []),
  };
}

// List rows carry queue counts, not the queued text. A stream fills in the
// text for the one session its client has open; `queuedMessagesFor` is what
// makes that row differ from the shared projection.
function publicSessions(rows: any[], local: Thread[] = threads.snapshot({ archived: false })): Session[] {
  const parents = new Set(local.map(thread => thread.parentId));
  const localIds = new Set(local.map(thread => thread.id));
  return rows.filter(row => !ROOMS_ENABLED || !roomMetadata(row.metadata?.room)).map(row => publicSession(row, parents.has(row.id) || Boolean(peerChildren.get(row.id)), false,
    localIds.has(row.id) || (row.archived_at && threads.get(row.id)) ? "person" : "fleet"));
}
function pendingMessages(id: string) {
  return threads.get(id) ? threads.pending(id) : peerInspections.get(id)?.pending ?? [];
}
function queuedMessagesFor(id: string): QueuedMessage[] {
  const acknowledgement = liveThread(id)?.metadata?.acknowledgementWait as { overdue?: boolean } | undefined;
  return pendingMessages(id).filter(message => !message.landedAt).map(message => {
    // A message the runtime has taken cannot be edited, steered or removed;
    // one still waiting can be all three, whether or not the thread is held.
    const waiting = message.state === "queued";
    return {
      id: message.id, text: decodeMessageReply(message.text).text, delivery: message.delivery,
      state: waiting ? "queued" as const : "dispatched" as const,
      ...(!waiting && message.insertedAt == null ? { acknowledgement: acknowledgement?.overdue ? "unconfirmed" as const : "pending" as const } : {}),
      canSteer: waiting && message.delivery === "queue",
      canHardSteer: waiting,
      canCancel: waiting,
      createdAt: new Date(message.createdAt).toISOString(),
    };
  });
}
function publicSession(row: any,
  hasChildren = threads.snapshot({ archived: false }).some(thread => thread.parentId === row.id) || Boolean(peerChildren.get(row.id)),
  queued = true,
  origin: Session["origin"] = threads.get(row.id) ? "person" : "fleet",
): Session {
  const live = liveProjections.get(row.id);
  return {
    id: row.id, parentId: row.parentId,
    hasChildren,
    origin,
    watchList: row.metadata?.watchList === true,
    manager: row.metadata?.manager === true,
    foreground: typeof row.metadata?.foreground === "boolean" ? row.metadata.foreground : origin === "person" && !row.parentId && !row.metadata?.watchList,
    agentName: typeof row.metadata?.agentName === "string" ? row.metadata.agentName : liveThread(row.id)?.agentName,
    dependencies: row.metadata?.peerDependencies,
    attentionSummary: typeof row.metadata?.attentionSummary === "string" ? row.metadata.attentionSummary : undefined,
    waitingOnAgents: row.waitingOnAgents,
    wakeSchedule: row.wakeSchedule,
    model: (row.effectiveSettings ?? row.settings).model, name: row.name, color: row.color, cwd: row.cwd,
    workspaceName: workspaces.get(row.workspace_id)?.name ?? row.cwd,
    environment: ENVIRONMENT_ID, state: row.state, held: Boolean(row.held),
    ...projectThreadActivity(row),
    provider: canonicalModelProvider(String(row.current_provider)).replace(/^openai-codex$/, "openai"),
    createdAt: row.created_at, updatedAt: row.updated_at,
    ...(row.lastUserMessageAt !== undefined ? { lastUserMessageAt: new Date(row.lastUserMessageAt).toISOString() } : {}),
    revision: row.revision,
    idleUnread: notificationUnread(db, currentNotificationPolicy(), row.id, Boolean(row.idle_unread)),
    humanAttention: currentNotificationPolicy()?.view === "classic" || notificationUnread(db, currentNotificationPolicy(), row.id, Boolean(row.idle_unread)),
    queuedMessages: queued ? queuedMessagesFor(row.id) : [],
    ...(queued ? { inputs: threads.get(row.id) ? threads.inputStates(row.id) : peerInspections.get(row.id)?.inputs } : {}),
    archivedAt: row.archived_at,
  };
}

// ---------------------------------------------------------------------------
// The event stream
//
// Shared work happens once: the inbox projection is built and encoded per
// version, the dashboard once per refresh, the transcript at native message boundaries.
// Each stream then sends its client only what that client does not already
// hold, which it remembers on the ClientStream.

function bootstrap(): Bootstrap {
  return { environmentId: ENVIRONMENT_ID, home: HOME, managerOwnerEnvironmentId: MANAGER_ENVIRONMENT_ID, manager: manager?.snapshot() ?? null, threadStarts: threadStartProfiles(), speech: speech?.catalog() ?? null, ...(ROOMS_ENABLED ? { rooms: true } : {}) };
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
    if (stream.subscription.viewing && stream.subscription.session) void markSessionViewed(stream.subscription.session)
      .catch(error => console.error("[supervisor] recording thread view failed", error));
  }
  projectState();
  for (const stream of streams.values()) sendState(stream);
  pushBootstrap();
  for (const stream of streams.values()) { sendImages(stream); void sendQuestions(stream); }
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
  const sessions = streamSessions(stateSnapshot.sessions, selected).map(session => session.id === selected
    ? { ...session, queuedMessages: queuedMessagesFor(selected), inputs: threads.get(selected) ? threads.inputStates(selected) : peerInspections.get(selected)?.inputs } : session);
  stream.publish({ type: "state", sessions, archivedTotal: stateSnapshot.archivedTotal, ownerErrors: stateSnapshot.ownerErrors });
  if (stream.subscription.workers) stream.publish({ type: "workers", sessions: fleetSessions(stateSnapshot.sessions) });
}

function sendImages(stream: ClientStream): void {
  const sessionId = stream.subscription.session;
  if (!sessionId) return;
  stream.publish({ type: "images", sessionId, snapshot: inlineImages.snapshot(sessionId) });
}

async function readSessionQuestions(id: string) {
  const policy = await loadNotificationPolicy();
  if (!policy.ok) return policy;
  const result = await (threads.get(id) ? threads.questions(id) : peerThreads.has(id) && fleet ? fleet.questions(id) : directory.questions(id));
  return result.ok ? { ok: true as const, value: humanQuestions(db, policy.value, result.value) } : result;
}
const questionFeed = new QuestionFeed(readSessionQuestions, resource => {
  const policy = currentNotificationPolicy();
  const questions = humanQuestions(db, policy, resource.questions);
  return policy?.view !== "classic" && questions.length === 0 ? { state: "ready", questions: [] } : { ...resource, questions };
});
async function sendQuestions(stream: ClientStream): Promise<void> {
  const sessionId = stream.subscription.session;
  if (!sessionId || !sessionRow.get(sessionId)) return;
  await questionFeed.send(stream);
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

async function pushNotifications(target?: ClientStream): Promise<void> {
  const policy = await loadNotificationPolicy();
  if (!policy.ok) return;
  for (const stream of target ? [target] : [...streams.values()]) {
    let cursor = stream.subscription.notificationsAfter;
    if (cursor === undefined) continue;
    for (let page = 0; page < 16; page++) {
      const feed = idleNotifications(db, cursor, notificationThread, currentNotificationPolicy());
      stream.subscription.notificationsAfter = feed.cursor;
      if (page === 0 && target || feed.cursor !== cursor || feed.notifications.length) stream.send({ type: "notifications", feed: { ...feed, policy: policy.value } });
      if (cursor === null || cursor === feed.cursor) break;
      cursor = feed.cursor;
    }
  }
}

function sendLive(stream: ClientStream): void {
  const sessionId = stream.subscription.session;
  if (!sessionId) return;
  const runtime = liveProjections.get(sessionId);
  stream.publish({ type: "live", sessionId, text: runtime?.liveText ?? "", messageTimestamp: runtime?.messageTimestamp ?? null,
    ...(stream.subscription.thinking ? { thinking: runtime?.liveThinking ?? "" } : {}) });
}

function pushLive(): void {
  for (const stream of streams.values()) {
    sendLive(stream);
    sendEvents(stream);
  }
}

const TRANSCRIPT_COALESCE_MS = 100;
const transcriptTimers = new Map<string, ReturnType<typeof setTimeout>>();

function sessionSubscribers(sessionId: string): ClientStream[] {
  return [...streams.values()].filter(stream => stream.subscription.session === sessionId);
}

async function refreshTranscript(sessionId: string): Promise<SourceResult<void>> {
  const results = await Promise.all(sessionSubscribers(sessionId).map(stream => sendTranscript(stream)));
  for (const result of results) if (!result.ok) return result;
  return { ok: true, value: undefined };
}

function signalTranscript(sessionId: string): void {
  if (shuttingDown || transcriptTimers.has(sessionId) || !sessionSubscribers(sessionId).length) return;
  transcriptTimers.set(sessionId, setTimeout(() => {
    transcriptTimers.delete(sessionId);
    const failed = (message: string) => {
      for (const stream of sessionSubscribers(sessionId)) stream.send({ type: "error", message: `Could not read transcript: ${message}` });
    };
    void refreshTranscriptProjection(() => refreshTranscript(sessionId), () => signalTranscript(sessionId), error => {
      failed(`${error.code}: ${error.message}`);
    }).catch(cause => failed(cause instanceof Error ? cause.message : String(cause)));
  }, TRANSCRIPT_COALESCE_MS));
}

async function sendTranscript(stream: ClientStream): Promise<SourceResult<void>> {
  const sessionId = stream.subscription.session;
  if (!sessionId) return { ok: true, value: undefined };
  const revision = stream.revision;
  const loaded = await transcripts.page(sessionId, undefined, 60);
  if (!loaded.ok) return loaded;
  let page = loaded.value;
  const from = stream.subscription.transcriptFrom;
  const limit = from == null ? 60 : Math.min(600, Math.max(60, page.total - from));
  if (limit > 60) {
    const expanded = await transcripts.page(sessionId, undefined, limit);
    if (!expanded.ok) return expanded;
    page = expanded.value;
  }
  if (!stream.closed && stream.revision === revision && stream.subscription.session === sessionId)
    stream.publish({ type: "transcript", ...page });
  return { ok: true, value: undefined };
}

/** Apply a subscription change and push whatever it now entitles the client to. */
async function applySubscription(stream: ClientStream, patch: Partial<StreamSubscription>, mode: "push" | "finite"): Promise<void> {
  const before = stream.subscription;
  stream.declare(patch);
  const revision = stream.revision;
  const sessionId = stream.subscription.session ?? null;
  const changedSession = (before.session ?? null) !== sessionId;

  if (sessionId && stream.subscription.viewing) await markSessionViewed(sessionId,
    changedSession || !before.viewing || before.selectionId !== stream.subscription.selectionId);
  const pending: Promise<void>[] = [];
  if (sessionId) {
    if (mode === "push") sendLive(stream);
    sendImages(stream);
    if (mode === "finite") pending.push(sendQuestions(stream));
    else void sendQuestions(stream);
    sendEvents(stream);
    const fresh = changedSession || before.selectionId !== stream.subscription.selectionId;
    pending.push(stream.synchronizeSelection(
      () => sessionRow.get(sessionId) ? refreshThreadInspection(sessionId, fresh) : Promise.resolve(),
      async () => {
        sourceValue(await sendTranscript(stream));
        sendLive(stream);
        projectState();
        sendState(stream);
      },
    ));
  }
  if (!sessionId) {
    projectState();
    sendState(stream);
  }
  stream.publish({ type: "bootstrap", bootstrap: bootstrap() });
  if (patch.notificationsAfter !== undefined) pushNotifications(stream);
  if (stream.subscription.dashboard) {
    if (!dashboardSnapshot) await refreshDashboard();
    if (!stream.closed && stream.revision === revision && dashboardSnapshot) stream.publish({ type: "dashboard", dashboard: dashboardSnapshot });
  }
  await Promise.all(pending);
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
  if (["pending", "stop", "length", "toolUse", "deferred"].includes(stopReason)) return "";
  if (stopReason !== "error" && stopReason !== "aborted") return `Unsupported model completion reason: ${stopReason || "(missing)"}`;
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
    return block ? `[Unsupported tool-result block · ${String(block.type ?? "missing type")}]\n${JSON.stringify(block)}` : "";
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
  const presentation = parsePresentationEvent(event);
  if (!presentation.ok) {
    emit(sessionId, "notice", { text: `Runtime protocol error: ${presentation.error.slice(0, 500)}` });
    return;
  }
  try { phoneOverlay?.event(sessionId, event); } catch (cause) { console.error("phone overlay event failed", cause); }
  ensureThreadView(db, sessionId);
  const rt = liveFor(sessionId);
  if (observeExecutionActivity(rt, event)) {
    rt.compacting = rt.activity === "compacting";
    rt.retrying = rt.activity === "retrying";
    rt.thinkingActive = rt.activity === "thinking";
    signalSync();
    signalLiveSync();
  }
  if (event.type === "entry_appended" || event.type === "session_changed" || event.type === "command_settled") signalTranscript(sessionId);
  if (event.type === "agent_end" || event.type === "agent_settled") settleLiveProjection(rt);
  if (event.type === "response" && event.command === "get_state" && event.success && event.data?.live) {
    restoreLiveProjection(rt, event.data.live);
    invalidateDisplayContext(sessionId);
    signalSync();
    signalLiveSync();
    return;
  }
  if (event.type === "thread_error") {
    emit(sessionId, "notice", { text: String(event.error) });
    return;
  }
  if (event.type === "thread_message_inserted") {
    const annotation = db.query("SELECT meeting_transcript FROM message_annotations WHERE work_id=?").get(event.workId) as { meeting_transcript: string } | null;
    const handoff = annotation ? meetingHandoffText(JSON.parse(annotation.meeting_transcript)) : "";
    emit(sessionId, "user", { text: [event.message.text, handoff].filter(Boolean).join("\n\n"),
      delivery: event.message.delivery, workId: event.workId }, `inserted:${event.workId}`);
    return;
  }
  if (event.type === "thread_settled") {
    responseTiming.forget(sessionId);
    settleLiveProjection(rt);
    void refreshThreadNotifications();
    emit(sessionId, "settled", { workId: event.workId, outcome: event.outcome }, `settled:${event.executionId}`);
    if (event.outcome === "failed") emit(sessionId, "notice", {
      text: modelFailureText(event.finalMessage) ?? "The thread execution failed",
    }, `failure:${event.executionId}`);
    return;
  }

  if (!presentation.project) return;

  // Time responses by when Pi produced each event, not when it reached this
  // supervisor: delivery can arrive in bursts, which made a whole response
  // look like it streamed in a few hundred milliseconds (over 1000 tok/s).
  const eventAt = typeof event.emittedAt === "number" ? event.emittedAt : Date.now();
  if (event.type === "message_start" && event.message?.role === "assistant") {
    rt.liveText = "";
    rt.liveThinking = "";
    rt.messageTimestamp = typeof event.message.timestamp === "number" ? event.message.timestamp : null;
    responseTiming.start(sessionId, eventAt);
    signalLiveSync();
  }
  if (event.type === "message_update" && ["text_delta", "thinking_delta"].includes(String(event.assistantMessageEvent?.type)))
    responseTiming.firstToken(sessionId, eventAt);

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
    signalTranscript(sessionId);
    if (rt.thinkingActive) { rt.thinkingActive = false; touchSession(sessionId); }
    const text = textFromMessage(event.message);
    if (event.message?.role === "assistant") {
      inlineImages.accept(sessionId, sha256(text), text);
      recordResponseMetrics(sessionId, responseTiming.finish(sessionId, event.message, eventAt), messageFinalizationKey(event.message));
      rt.liveText = "";
      rt.messageTimestamp = null;
      rt.liveThinking = "";
      rt.thinkingBlockStart = 0;
      signalTranscript(sessionId);
      signalLiveSync();
    }
    if (text && event.message?.role === "assistant") {
      emit(sessionId, "assistant", { text }, `assistant:${messageFinalizationKey(event.message)}`);
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
    touchSession(sessionId);
    emit(sessionId, "notice", { text: "Compacting context…" });
  } else if (event.type === "compaction_end") {
    rt.compacting = false;
    signalTranscript(sessionId);
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
  return { ...process.env, HOME, PI_PERSON_SETTINGS_DATA: DATA,
    PI_REMOTE_WORKSPACES: JSON.stringify([...workspaces.values()]),
    PI_REMOTE_SESSION_ID: thread.id, PI_THREAD_API_URL: `http://${HOST}:${PORT}/v1/threads`,
    PI_REMOTE_SENDER_ID: MESSAGE_OWNER.id, PI_REMOTE_SENDER_NAME: MESSAGE_OWNER.name,
    ...(ROOMS_ENABLED && roomMetadata(thread.metadata?.room) ? { PI_REMOTE_ROOM_ID: thread.id } : {}),
    PI_SESSION_ID: thread.id, PI_SESSION_FILE: thread.sessionFile,
    PI_REMOTE_MEETING_ID: String(meta.meetingId ?? ""),
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
async function runCommand(row: any, requestId: string, name: string, args: string, humanActivity: boolean) {
  const previous = requestResult(requestId);
  if (previous) return { response: JSON.parse(previous.response), status: previous.status };
  const response = name === "compact"
    ? await rpc(row.id, "compact", { id: requestId, customInstructions: args || undefined })
    : await enqueuePrompt(row.id, requestId, `/${name}${args ? ` ${args}` : ""}`, resolveDelivery({}), [], humanActivity);
  saveRequest(requestId, row.id, "command", 202, response);
  return { response, status: 202 };
}
async function directChildren(id: string): Promise<Result<Session[]>> {
  const owner = await directory.owner(id);
  if (!owner.ok) return owner;
  const children: Thread[] = [];
  let cursor: string | undefined;
  do {
    const page = await directory.list({ parentId: id, limit: 1000, cursor });
    if (!page.ok) return page;
    children.push(...page.value.threads);
    cursor = page.value.nextCursor;
  } while (cursor);
  for (const thread of children) if (!threads.get(thread.id)) { peerThreads.set(thread.id, thread); ensureThreadView(db, thread.id); }
  if (!threads.get(id)) peerChildren.set(id, children.length > 0);
  const lookup = cachedThreadLookup(new Map(children.map(thread => [thread.id, thread])), liveThread);
  return { ok: true, value: publicSessions(children.map(thread => threadRow(thread, lookup))) };
}

async function threadSettings(row: any) {
  const metadata = threadSettingsMetadata(row.settings, threads.get(row.id) ? THREAD_MODEL_CATALOG : undefined);
  const effective = row.effectiveSettings ? threadSettingsMetadata(row.effectiveSettings).model : null;
  return {
    ...metadata,
    effectiveModel: row.effectiveSettings?.model ?? null,
    waiting: row.metadata?.admissionWait ? "admission" : row.metadata?.providerWait?.phase === "retry" ? "retry" : row.metadata?.providerWait ? "provider" : null,
    canRetryWaiting: !row.held && !row.archived_at && Boolean(row.metadata?.providerWait || row.metadata?.admissionWait)
      && Boolean(effective && (effective.provider !== metadata.model.provider || effective.id !== metadata.model.id)),
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

const handoffHistory: HandoffHistory = {
  async *receipts(sessionId) {
    let after = 0;
    while (true) {
      const rows = db.query("SELECT rowid,work_id,octet_length(meeting_transcript) AS bytes FROM message_annotations WHERE session_id=? AND rowid>? ORDER BY rowid LIMIT 64")
        .all(sessionId, after) as Array<{ rowid: number; work_id: string; bytes: number }>;
      if (!rows.length) return;
      const inspected = await directory.inspect(sessionId, { inputReceipts: { workIds: rows.map(row => row.work_id) } });
      if (!inspected.ok) throw new Error(`${inspected.error.code}: ${inspected.error.message}`);
      if (!inspected.value.inputReceipts) throw new Error("Native handoff delivery receipts are unavailable");
      const landed = new Set(inspected.value.inputReceipts.filter(receipt => receipt.landedAt !== null).map(receipt => receipt.workId));
      for (const row of rows) {
        if (row.bytes > 8 * 1024 * 1024) throw new Error("oversized: Meeting handoff receipt exceeds the 8 MiB record limit");
        if (!landed.has(row.work_id)) continue;
        const receipt = db.query("SELECT meeting_transcript FROM message_annotations WHERE rowid=? AND session_id=?")
          .get(row.rowid, sessionId) as { meeting_transcript: string } | null;
        if (!receipt) throw new Error("stale_source: Meeting handoff annotation disappeared");
        yield { transcript: receipt.meeting_transcript, delivered: true };
      }
      after = rows.at(-1)!.rowid;
    }
  },
};

async function prepareThreadMessage(thread: Thread, message: ThreadMessage): Promise<Result<{text: string; images?: unknown[]}>> {
  const room = ROOMS_ENABLED && roomMetadata(thread.metadata?.room);
  if (room && message.id.startsWith("question-answer:")) {
    const stored = db.query("SELECT value FROM metadata WHERE key=?").get(`room-answer:${message.id}`) as { value: string } | null;
    const sender = stored && roomMembers([JSON.parse(stored.value)])?.[0];
    if (!sender) return { ok: false, error: { code: "unavailable", message: "Room question answer has no authenticated speaker" } };
    return { ok: true, value: { text: roomInput(sender, message.text), images: message.images } };
  }
  const meetingId = remotePlacement(thread).meetingId;
  if (typeof meetingId !== "string" || !meetingId) return { ok: true, value: { text: message.text, images: message.images } };
  try {
    await meet.flushTranscript(meetingId);
    const transcript = await prepareMeetingHandoff(meet.transcripts, meetingId, thread.id, handoffHistory);
    db.query("INSERT OR REPLACE INTO message_annotations(work_id,session_id,created_at,meeting_transcript) VALUES(?,?,?,?)")
      .run(message.id, thread.id, now(), JSON.stringify(transcript));
    const handoff = meetingHandoffText(transcript);
    return { ok: true, value: { text: [message.text, handoff].filter(Boolean).join("\n\n"), images: message.images } };
  } catch (cause) {
    return { ok: false, error: { code: "unavailable", message: cause instanceof Error ? cause.message : String(cause) } };
  }
}

function notificationThread(id: string): { parentId: string | null; role?: "agent" | "conversation" | "worker"; foreground?: boolean } | null {
  const thread = threads.get(id) ?? peerThreads.get(id);
  if (ROOMS_ENABLED && roomMetadata(thread?.metadata?.room)) return null;
  if (thread) return { parentId: thread.parentId, role: thread.role,
    foreground: typeof thread.metadata?.foreground === "boolean" ? thread.metadata.foreground : undefined };
  return ROOMS_ENABLED && db.query("SELECT value FROM metadata WHERE key=?").get(`room-link:${id}`) ? { parentId: null } : null;
}

async function enqueuePrompt(sessionId: string, requestId: string, text: string, delivery: "queue" | "steer" | "hardSteer", images: ImageContent[] = [], humanActivity = false) {
  const sent = await directory.send({ threadId: sessionId, requestId, text, delivery, images, humanActivity });
  const message = unwrap(sent);
  return { accepted: true, workId: message.id, delivery: message.delivery, session: publicSession(sessionRow.get(sessionId)) };
}
function meetingDestination() {
  return [...THREAD_DESTINATIONS.values()].find(destination => destination.id === "home")
    ?? [...THREAD_DESTINATIONS.values()][0];
}
async function insertThread(id: string, name: string, destination: ThreadDestination, model: string,
  meetingId: string | null, message?: string, parentId?: string, settings?: Parameters<typeof directory.spawn>[0]["settings"], contextFiles: string[] = [], createdBy?: ThreadCreator, mode?: ThreadModeName) {
  const admitted = workspaceAdmission.resolve(destination.workspaceId);
  if (!admitted.ok) throw new Error(admitted.error.message);
  const thread = unwrap(await directory.spawn({ id, requestId: id, title: name, parentId, createdBy,
    cwd: admitted.value.cwd, message, settings: { model, ...settings },
    metadata: { workspaceId: destination.workspaceId, profileId: destination.id, meetingId, ...(mode ? { mode, liveDispatcher: mode === "live" } : {}), ...(destination.raw ? { raw: true } : {}),
      ...(destination.sandbox ? { sandbox: true } : {}),
      ...(contextFiles.length ? { contextFiles } : {}) },
  }));
  ensureThreadView(db, thread.id);
  return thread;
}
const unsubscribeThreads = threads.subscribe(change => {
  if ("event" in change) handlePiEvent(change.threadId, change.event);
  else { ensureThreadView(db, change.threadId); const thread = threads.get(change.threadId); if (thread) noteModelRecency(thread); if (thread?.metadata?.rootConsent === true) signalTranscript(change.threadId); signalSync(); void refreshThreadNotifications(); }
});
{
  const table = threadTable();
  for (const thread of table.all) { ensureThreadView(db, thread.id); noteModelRecency(thread, table.lookup); }
}
await inlineImages.start();

const meetingRuntime = await MeetGateway.connect(db, {
  sessionExists: (id) => {
    const row = sessionRow.get(id) as any;
    return Boolean(row && !row.archived_at);
  },
  threadActivity: (meetingId, rootId) => meetingActivity(id => activity.recent(id, ["tool_start", "tool_end", "assistant", "notice"], 8), allThreadRows().filter(row => row.meeting_id === meetingId), rootId, (row) => {
  const runtime = liveProjections.get(row.id);
  // Ephemeral meeting workers are archived and held when they finish; the room must not show that as "Stopped".
  const finished = Boolean(row.archived_at) && row.state === "idle";
  return { state: row.state, held: Boolean(row.held) && !finished, finished,
    ...projectThreadActivity(row),
    waitingOnAgents: row.waitingOnAgents,
    tools: row.executionActivity?.activeTools ?? [...(runtime?.activeTools.values() ?? [])], output: runtime?.liveText ?? "" };
  }),
});
if (!meetingRuntime.ok) throw new Error(`Meeting runtime unavailable: ${meetingRuntime.error}`);
const meet = meetingRuntime.value;


const messaging = createMessagingService(DATA, PRIVATE_DIR, ENVIRONMENT_REQUIRES_UNLOCK, () => { trackFeature("signal", "agent"); });
const calendar = new CalendarStore(DATA, process.env.PI_REMOTE_SENDER_ID ?? process.env.USER ?? "user", process.env.PI_REMOTE_CALENDAR_FEED_BASE);
if (process.env.PI_PERSON_TIMEZONE_FILE) {
  if (!calendar.timezoneMigration.ok) throw new Error(`Owner timezone migration unavailable: ${calendar.timezoneMigration.error.message}`);
  const timezone = reconcilePersonTimezoneProjection(DATA, process.env.PI_PERSON_TIMEZONE_FILE);
  if (!timezone.ok) throw new Error(`Owner timezone projection unavailable: ${timezone.error.message}`);
}
observeError(db, "settings-migration", calendar.timezoneMigration.ok ? null : calendar.timezoneMigration.error.message);
calendar.start();
type SocketData = PhoneSocketData;
const phones = new PhoneBroker({
  commandUsed: () => { trackFeature("phone", "agent"); },
  overlayMessage: async (device, message) => {
    const result = await phoneOverlay!.message(device, message);
    if (result.ok) trackFeature("overlay", "phone", message.id);
    return result;
  },
  ready: device => {
    const enabled = device.capabilities.overlayEnabled;
    if (typeof enabled === "boolean") {
      const result = featureUsage.record({ id: crypto.randomUUID(), feature: "overlay", kind: "state", state: enabled ? "enabled" : "disabled" }, "phone");
      if (!result.ok) observeError(db, "feature-usage", result.error.message);
    }
    phoneOverlay?.ready(device);
  },
});
phoneOverlay = new PhoneOverlay({
  thread: id => { const row = sessionRow.get(id) as any; return row ? { archived: Boolean(row.archived_at) } : null; },
  create: async (message, device) => {
    const destination = meetingDestination();
    const id = crypto.randomUUID();
    await insertThread(id, `Phone · ${device.name}`, destination, destination.defaultModel, null, message, undefined, undefined, [], { kind: "person", via: "upstream" });
    signalSync();
    return id;
  },
  prompt: async (threadId, requestId, text) => { await enqueuePrompt(threadId, requestId, text, "steer", [], true); },
  send: (deviceId, command, args) => phones.send(deviceId, command, args),
  online: deviceId => phones.online(deviceId),
  load: () => (db.query("SELECT key,value FROM metadata WHERE key LIKE 'phone-overlay:%'").all() as Array<{ key: string; value: string }>)
    .map(row => ({ deviceId: row.key.slice("phone-overlay:".length), threadId: row.value })),
  save: (deviceId, threadId) => { db.query("INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)").run(`phone-overlay:${deviceId}`, threadId); },
  log: message => console.warn(message),
});
const requestTimings = new RequestTimings();
const server = Bun.serve<SocketData>({
  hostname: HOST,
  port: PORT,
  idleTimeout: 30,
  async fetch(req, httpServer) {
    return jsonHttp(req, await (async () => {
    const url = new URL(req.url);
    if (req.method === "OPTIONS" && url.pathname.startsWith("/v1/")) {
      return new Response(null, {
        status: 204,
        headers: { ...API_CORS_HEADERS, "access-control-max-age": "86400" },
      });
    }
    if (!ownsSupervisorLease()) return error("Supervisor instance was replaced", 503);
    if (shuttingDown && !supervisorRelease.accepts(req.method, url.pathname)) return error("Supervisor is handing over; retry after activation", 503);
    if (API.health.match(req.method, url.pathname)) return json({ ok: true, version: VERSION, environmentId: ENVIRONMENT_ID, releaseCommit: RELEASE_COMMIT, meetingRuntime: { protocol: "meet-runtime-v1", lifetime: "person-service" } });
    const peer = httpServer.requestIP(req);
    const caller: CallerSource = { headers: req.headers, socket: peer ? { address: peer.address, port: peer.port, localAddress: HOST, localPort: PORT } : undefined };
    const humanCaller = () => { const resolved = callers.resolve(caller); return !("error" in resolved) && resolved.kind === "person"; };
    if (API.featureUsage.match(req.method, url.pathname) || API.recordFeatureUsage.match(req.method, url.pathname)) {
      const resolved = callers.resolve(caller);
      if ("error" in resolved || !phoneCallerAllowed(resolved, process.getuid?.() ?? -1)) return error("Feature usage requires this person's authorized caller", 403);
      if (req.method === "GET") {
        const result = featureUsage.summary();
        return json(result, result.ok ? 200 : 503);
      }
      let input: unknown;
      try { input = await readBody(req); } catch { return error("Expected feature event JSON", 400); }
      const parsed = parseFeatureEvent(input);
      if (!parsed.ok) return json(parsed, 400);
      const result = featureUsage.record(parsed.value, resolved.kind === "person" ? "human" : "agent");
      return json(result, result.ok ? 200 : 503);
    }
    if (url.pathname.startsWith("/v1/telephone/")) {
      const destination = meetingDestination();
      const admitted = workspaceAdmission.resolve(destination.workspaceId);
      if (!admitted.ok) return error(admitted.error.message, 503);
      return telephoneDispatcher(req, { threads, owner: MESSAGE_OWNER.id, cwd: admitted.value.cwd,
        model: destination.defaultModel, loopback: peer?.address === "127.0.0.1" || peer?.address === "::1",
        onApproved: callId => { trackFeature("telephone", "agent", callId); } });
    }
    if (API.settings.match(req.method, url.pathname)) return json(await settingsService.snapshot());
    const settingUpdate = API.updateSetting.match(req.method, url.pathname);
    if (settingUpdate) {
      let body: unknown;
      try { body = await readBody(req); } catch { return json({ error: "Expected JSON setting value", code: "invalid" }, 400); }
      const saved = await settingsService.update(settingUpdate.id, body);
      if (saved.ok) return json({ entry: saved.value });
      const status = saved.error.code === "forbidden" ? 403 : saved.error.code === "unknown-setting" ? 404 : saved.error.code === "unavailable" ? 503 : 400;
      return json({ error: saved.error.message, code: saved.error.code }, status);
    }
    if (url.pathname.startsWith("/v1/room-owner/")) {
      if (!ROOMS_ENABLED) return error("Not found", 404);
      if (process.env.PI_REMOTE_ROOMS_RUNTIME !== "1" && !url.pathname.endsWith("/notify")) return error("Room execution requires the unprivileged room supervisor", 403);
      const resolved = callers.resolve(caller);
      if ("error" in resolved || resolved.kind !== "person" || resolved.via !== "router") return error("Rooms require the authenticated local router", 403);
      return handleRoomOwner(req, {
        subscribe: listener => threads.subscribe(change => listener(change.threadId)),
        get: id => threads.get(id) ?? null,
        create: async (id, title, members) => {
          const destination = meetingDestination();
          if (destination.raw || destination.sandbox) throw new Error("Rooms require a full-context destination");
          const admitted = workspaceAdmission.resolve(destination.workspaceId);
          if (!admitted.ok) throw new Error(admitted.error.message);
          unwrap(await directory.spawn({ id, requestId: id, title, cwd: admitted.value.cwd,
            settings: { model: destination.defaultModel }, createdBy: { kind: "person", via: "router" },
            metadata: { workspaceId: destination.workspaceId, profileId: destination.id, room: { id, members } } }));
          ensureThreadView(db, id);
        },
        update: async (id, members) => { unwrap(threads.update(id, { metadata: { room: { id, members } } })); },
        send: async (id, requestId, text) => { await enqueuePrompt(id, requestId, text, "queue", [], humanCaller()); },
        history: async (id, options) => {
          const inspect = async (before: number | undefined, limit: number, revision?: string) => {
            const result = await directory.inspect(id, { contextRecords: { includeEntries: true,
              ...(before === undefined ? {} : { before }), limit, ...(revision === undefined ? {} : { revision }) } });
            if (!result.ok) throw new RoomHistoryError(result.error.code === "conflict" ? 409 : result.error.code === "oversized" ? 413 : 503, result.error.message);
            if (!result.value.contextRecords) throw new RoomHistoryError(503, "The room owner did not return native records");
            return result.value.contextRecords;
          };
          const initial = options.before === undefined ? await inspect(undefined, 1, options.revision) : null;
          const page = await inspect(options.before ?? initial!.total, options.limit ?? 32, options.revision ?? initial?.source.revision);
          const messages = page.records.map(record => ({ ...record.message, identity: { ...record.message.identity, id: `pi/${id}/${record.entryId}` } }));
          const questions = unwrap(await directory.questions(id));
          const current = threads.get(id)!;
          const settlement = threads.latestSettlement(id);
          const rejection = messages.findLast((message: any) => message.role === "notice" && message.content?.customType === "thread_rejected" && message.content.data?.workId === settlement?.workId) as any;
          const failure = current.state !== "running" && settlement?.outcome === "failed"
            ? settlement.error ?? rejection?.content.data.error ?? modelFailureText(settlement.finalMessage) ?? "The room execution failed" : undefined;
          const end = Math.min(options.before ?? page.total, page.total);
          const start = page.records[0]?.index ?? end;
          return { messages, paging: { revision: page.source.revision, total: page.total, start, end,
            hasOlder: start > 0, nextBefore: start > 0 ? start : null }, ...(failure ? { error: failure } : {}),
            live: liveProjections.get(id)?.liveText ?? "", thinking: liveProjections.get(id)?.liveThinking ?? "",
            execution: projectThreadActivity(current), questions };
        },
        stop: async id => { unwrap(await directory.control({ threadId: id, action: "cancel" })); },
        answer: async (id, questionId, sender, body) => {
          const key = `room-answer:question-answer:${questionId}`;
          const previous = db.query("SELECT value FROM metadata WHERE key=?").get(key) as { value: string } | null;
          if (previous && JSON.parse(previous.value).user !== sender.user) throw new Error("Another room member already answered this question");
          db.query("INSERT OR IGNORE INTO metadata(key,value) VALUES(?,?)").run(key, JSON.stringify(sender));
          const answered = await directory.answer({ threadId: id, questionId, humanActivity: humanCaller(), selectedSuggestionIds: body?.selectedSuggestionIds, text: body?.text, dismissed: body?.dismissed });
          if (!answered.ok && !previous) db.query("DELETE FROM metadata WHERE key=?").run(key);
          unwrap(answered);
        },
        notify: async (id, receiptId, title, body, time) => {
          const policy = unwrap(await loadNotificationPolicy());
          const target = `room:${id}`;
          if (policy.view === "mono") {
            unwrap(await directory.send({ threadId: policy.managerThreadId, senderId: target, requestId: `manager-notice:room:${receiptId}`,
              source: "notification", delivery: "steer", text: `Room update from ${title} (${target}): ${body}` }));
          } else {
            db.query("INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)").run(`room-link:${target}`, "1");
            recordIdleNotification(db, receiptId, { id: target, title }, time, { kind: "idle", body });
          }
          signalSync();
        },
      });
    }
    const dismissNeed = API.dismissNeed.match(req.method, url.pathname);
    if (API.needsYou.match(req.method, url.pathname) || dismissNeed) {
      const resolved = callers.resolve(caller);
      if ("error" in resolved || !phoneCallerAllowed(resolved, process.getuid?.() ?? -1)) return error("Needs you requires this person's authorized router or local caller", 403);
      if (process.env.PI_REMOTE_ROOMS_RUNTIME === "1") return error("Life projections are not available in rooms", 403);
      if (url.search) return error("Needs you accepts no person or scope parameters", 400);
      const client = lifeClient();
      if (dismissNeed) {
        const target = parseNeedsYouDismissal(await readBody(req));
        if (target === null) return json({ ok: false, error: "invalid-request", message: "Expected a current need dismissal target." }, 400);
        const result = await dismissNeedsYou(target, {
          client, now: new Date().toISOString(),
          findQuestion: async questionId => {
            const pending = await readNeedsYouQuestions(directory.owners, thread => !roomMetadata(thread.metadata?.room), []);
            const question = pending.questions.find(question => question.id === questionId);
            if (question) return { ok: true, threadId: question.threadId };
            return pending.errors.length ? { ok: false, message: pending.errors.join("; ") } : { ok: true, threadId: null };
          },
          dismissQuestion: async (threadId, questionId) => {
            let questionDismissed = false;
            try {
              const source = await directory.inspect(threadId, { context: "omit" });
              if (!source.ok) return { ok: false, error: "question-failed", message: source.error.message };
              if (roomMetadata(source.value.thread.metadata?.room)) return { ok: false, error: "invalid-state", message: "Room questions must be settled in their room." };
              const answer = await directory.answer({ threadId, questionId, selectedSuggestionIds: [], text: "", dismissed: true });
              if (!answer.ok) return { ok: false, error: "question-failed", message: answer.error.message };
              questionDismissed = true;
              await questionFeed.settle(threadId);
              for (const stream of sessionSubscribers(threadId)) void sendQuestions(stream);
              return { ok: true };
            } catch (cause) { return { ok: false, error: "unavailable", message: cause instanceof Error ? cause.message : String(cause), ...(questionDismissed ? { questionDismissed: true as const } : {}) }; }
          },
        });
        signalSync();
        const status = result.ok ? 200 : result.error === "conflict" ? 409 : result.error === "not-found" ? 404 : result.error === "invalid-request" || result.error === "invalid-state" ? 400 : 503;
        return json(result, status);
      }
      const lifeRead = client.request<LifeSnapshot>({ operation: "read", target: { scope: "self" } });
      const [life, pending, watch, policy] = await Promise.all([
        lifeRead,
        lifeRead.then(life => readNeedsYouQuestions(directory.owners, thread => !roomMetadata(thread.metadata?.room),
          life.ok ? [...new Set(life.value.entities.filter(entity => entity.status === "current" && entity.threadId !== null).map(entity => entity.threadId!))] : [])),
        watchList.watch({ action: "list", threadId: "needs-you-projection" }).catch(cause => ({ ok: false as const, error: { code: "unavailable" as const, message: cause instanceof Error ? cause.message : String(cause) } })),
        client.request<LifePolicyView>({ operation: "policy-read", target: { scope: "self" }, includeHistory: false }),
      ]);
      const projection = projectNeedsYou(life, pending, watch, policy, Date.now());
      const notificationPolicy = await loadNotificationPolicy();
      if (!notificationPolicy.ok) return threadError(notificationPolicy.error);
      if (notificationPolicy.value.view === "mono") {
        const visible = new Set(humanQuestions(db, notificationPolicy.value, pending.questions).map(question => question.id));
        projection.items = projection.items.filter(item => item.kind === "question" && item.location?.questionId && visible.has(item.location.questionId));
      }
      return json(projection);
    }
    if (url.pathname === "/v1/calendar" || url.pathname.startsWith("/v1/calendar/")) {
      const feed = url.pathname.startsWith("/v1/calendar/feed/");
      if (!feed) {
        const resolved = callers.resolve(caller);
        if ("error" in resolved || !phoneCallerAllowed(resolved, process.getuid?.() ?? -1)) return error("Calendar access requires this person's authorized router or local caller", 403);
      }
      httpServer.timeout(req, 65);
      const response = await calendar.handle(req);
      if (!feed && response.ok && (req.method !== "GET" || !humanCaller())) trackFeature("calendar", humanCaller() ? "human" : "agent");
      return response;
    }
    if (url.pathname === "/v1/phones" || url.pathname.startsWith("/v1/phones/")) {
      const connecting = !!API.phoneConnect.match(req.method, url.pathname);
      const resolved = callers.resolve(caller);
      if ("error" in resolved || !phoneCallerAllowed(resolved, process.getuid?.() ?? -1, connecting)) return error("Phone access requires this person's authorized router or local caller", 403);
      if (connecting) {
        if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return error("WebSocket upgrade required", 400);
        return httpServer.upgrade(req, { data: { kind: "phone" } }) ? undefined : error("WebSocket upgrade failed", 400);
      }
      httpServer.timeout(req, 65);
      return await phones.handle(req) ?? error("Not found", 404);
    }
    const agentReaction = API.sessionReaction.match(req.method, url.pathname);
    if (agentReaction || API.messageReaction.match(req.method, url.pathname)) {
      httpServer.timeout(req, 60);
      if (agentReaction && !threads.get(agentReaction.sessionId)) return json({ ok: false, error: { code: "not_found", message: "Agent thread not found" } }, 404);
      let input: unknown;
      try { input = await req.json(); } catch { return json({ ok: false, error: { code: "invalid_request", message: "Expected a JSON reaction request" } }, 400); }
      const sender = agentReaction ? { id: "assistant", name: AGENT_NAME } : MESSAGE_OWNER;
      const result = await reactToMessage(input, sender, {
        pi: async (target, emoji, remove, actor) => {
          const thread = threads.get(target.sessionId);
          if (!thread || !await nativeMessageExists(thread.sessionFile, target.messageId)) {
            return { ok: false, error: { code: "not_found", message: "Message not found in this account's thread" } };
          }
          const reactions = piReactions.set(target, emoji, actor, remove);
          invalidateDisplayContext(target.sessionId);
          return { ok: true, value: reactions };
        },
        messaging: async () => ({ ok: false, error: { code: "agent_signal_required", message: "Use pi-signal react with a durable request ID" } }),
        slack: (target, emoji, remove) => slackReactions.react(target, emoji, remove),
      });
      return result.ok ? json({ ok: true, reactions: result.value }) : json(result, ["not_found", "message_not_found"].includes(result.error.code) ? 404 : 400);
    }
    if (/^\/v1\/agent-signal(?:\/|$)/.test(url.pathname)) {
      const resolved = callers.resolve(caller);
      if ("error" in resolved || !phoneCallerAllowed(resolved, process.getuid?.() ?? -1)) return error("Signal tools require this person's authorized local caller", 403);
      httpServer.timeout(req, 65);
      return await messaging.handle(req) ?? error("Unknown Signal tool operation", 404);
    }
    const speechResponse = speech ? await speech.handle(req) : null;
    if (speechResponse) {
      if (speechResponse.ok && API.speechUtterances.match(req.method, url.pathname)) trackFeature("speech", humanCaller() ? "human" : "agent");
      return speechResponse;
    }
    if (url.pathname.startsWith("/v1/manager-relay/")) {
      const resolved = callers.resolve(caller);
      return managerRelay(req, { db, environmentId: ENVIRONMENT_ID, threads, directory, manager: manager?.snapshot() ?? null,
        authorizedRouter: !("error" in resolved) && resolved.kind === "person" });
    }
    const ownedThreadResponse = await threadHttp(threads, req, "/v1/thread-owner", admissionFor(callers, caller));
    if (ownedThreadResponse) return ownedThreadResponse;
    const threadResponse = await threadHttp(directory, req, "/v1/threads", admissionFor(callers, caller));
    if (threadResponse) return threadResponse;
    const requestedSession = /^\/v1\/sessions\/([^/]+)(?:\/|$)/.exec(url.pathname);
    if (fleet && requestedSession && requestedSession[1] !== "archived") {
      const id = decodeURIComponent(requestedSession[1]!);
      if (!sessionRow.get(id)) {
        const loaded = await readPeerSession(fleet, id, id => threads.get(id), peerThreads);
        if (!loaded.ok) return threadError(loaded.error);
        if (loaded.value) for (const [id, thread] of loaded.value) { peerThreads.set(id, thread); ensureThreadView(db, id); }
      }
    }
    const externalResponse = await externalMeetingRequest(req, meet, (sessionId, meetingId, name) => ensureExternalMeetingThread(sessionId, meetingId, name, {
      existing: id => {
        const row = sessionRow.get(id) as any;
        return row ? { meetingId: row.meeting_id, archived: Boolean(row.archived_at) } : undefined;
      },
      get: id => threads.get(id),
      control: input => directory.control(input),
      create: async (id, meetingId, name, settings, mode) => {
        const destination = meetingDestination();
        if (!destination) throw new Error("This host needs a configured destination for meetings");
        await insertThread(id, name, destination, THREAD_MODELS.get(settings.model)!.id, meetingId, undefined, undefined, settings, [], undefined, mode);
      },
      warn: message => console.warn(message),
    }));
    if (externalResponse) {
      if (externalResponse.ok && req.method === "POST" && url.pathname === "/v1/meet/external") trackFeature("meet", humanCaller() ? "human" : "agent");
      return externalResponse;
    }
    const meetingResponse = await meet.handle(req);
    if (meetingResponse) return meetingResponse;
    const agentMeetingRequest = [API.sessionMeeting, API.sessionMeetingVoice, API.sessionMeetingShare, API.sessionMeetingStop, API.sessionMeetingFrame]
      .map((route) => route.match(req.method, url.pathname)).find(Boolean);
    if (agentMeetingRequest) {
      const row = sessionRow.get(agentMeetingRequest.sessionId) as any;
      if (!row?.meeting_id) return error("This is not a Meet thread", 404);
      return meet.handleAgent(req, row.meeting_id);
    }
    if (API.manager.match(req.method, url.pathname) || API.updateManager.match(req.method, url.pathname)) {
      if (!manager) return json({ code: "manager_owner", error: "This person's manager belongs to another environment", environmentId: MANAGER_ENVIRONMENT_ID }, 409);
      if (req.method === "GET") return json(manager.snapshot());
      if (!humanCaller()) return error("Only the person may change their conversation view", 403);
      const patch = parseManagerPatch(await req.json());
      if (!patch.ok) return threadError(patch.error);
      const updated = await manager.update(patch.value);
      return updated.ok ? json(updated.value) : threadError(updated.error);
    }
    const instructionsRequest = API.sessionInstructions.match(req.method, url.pathname);
    if (instructionsRequest) {
      if (!sessionRow.get(instructionsRequest.sessionId)) return error("Session not found", 404);
      return json({ instructions: threadInstructions(instructionsRequest.sessionId) });
    }
    const imageRequest = API.sessionImage.match(req.method, url.pathname);
    if (imageRequest) {
      const found = await transcripts.image(imageRequest.sessionId, imageRequest.hash);
      if (!found.ok) return error(found.error.message, found.error.code === "stale_source" ? 409 : 422);
      const image = found.value;
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
      const beforeText = url.searchParams.get("before");
      const before = beforeText === null ? undefined : Number(beforeText);
      const limitText = url.searchParams.get("limit");
      const limit = limitText === null ? 60 : Number(limitText);
      if (before !== undefined && (!Number.isSafeInteger(before) || before < 0) || !Number.isSafeInteger(limit) || limit < 1 || limit > 200)
        return error("Invalid transcript page", 400);
      const page = await transcripts.page(id, before, limit, url.searchParams.get("generation") ?? undefined);
      if (page.ok) return json(page.value);
      if (page.error.code === "stale_source") {
        const current = await transcripts.page(id, undefined, 60);
        return current.ok ? json({ error: page.error.message, ...current.value }, 409) : error(current.error.message, 422);
      }
      return error(page.error.message, page.error.code === "invalid_request" ? 400 : 422);
    }
    const itemRequest = API.sessionItem.match(req.method, url.pathname);
    if (itemRequest) {
      const id = itemRequest.sessionId;
      if (!sessionRow.get(id)) return error("Session not found", 404);
      const found = await transcripts.body(id, itemRequest.itemId);
      if (!found.ok) return error(found.error.message, found.error.code === "stale_source" ? 409 : 422);
      const body = found.value;
      if (body === undefined) return error("Transcript item not found", 404);
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
    if (API.requestTimingsRead.match(req.method, url.pathname)) return json({ requests: requestTimings.list() });
    if (API.requestTimings.match(req.method, url.pathname)) {
      const result = requestTimings.receive(await readBody(req));
      return json(result, result.ok ? 200 : 400);
    }
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
    if (API.voice.match(req.method, url.pathname)) {
      const result = await voice.status();
      return result.ok ? json(result.value) : error(result.error, result.status);
    }
    if (API.voiceOffer.match(req.method, url.pathname)) {
      const sessionId = url.searchParams.get("sessionId") ?? "";
      const row = sessionRow.get(sessionId) as any;
      if (!row) return error("Session not found", 404);
      if (row.archived_at) return error("Thread is archived", 409);
      const result = await voice.negotiate(row.id, await req.text(), await voiceInstructions(row));
      if (result.ok) trackFeature("voice", humanCaller() ? "human" : "agent");
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
    const modelAvailabilityUpdate = API.setModelAvailability.match(req.method, url.pathname);
    if (modelAvailabilityUpdate) {
      if (!HOST_ADMINISTRATOR) return error("Only the machine administrator can change global model availability", 403);
      let body: unknown;
      try { body = await readBody(req); }
      catch { return error("Expected JSON with an enabled boolean", 400); }
      if (!body || typeof body !== "object" || !("enabled" in body) || typeof body.enabled !== "boolean") return error("enabled must be a boolean", 400);
      const saved = await settingsService.update(`model.available:${modelAvailabilityUpdate.id}`, { value: body.enabled });
      if (!saved.ok) return error(saved.error.message, saved.error.code === "unavailable" ? 503 : saved.error.code === "unknown-setting" ? 404 : 400);
      return json({ models: availableThreadModels() });
    }
    if (API.actions.match(req.method, url.pathname)) {
      if (!HOST_ADMINISTRATOR) return error("Only the machine administrator can read system actions", 403);
      try { return json({ actions: await machineActions.refresh() }); }
      catch (cause: any) { return error(cause?.message ?? "Could not read machine actions", 503); }
    }
    const actionToggle = API.actionToggle.match(req.method, url.pathname);
    if (actionToggle) {
      if (!HOST_ADMINISTRATOR) return error("Only the machine administrator can change system actions", 403);
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
        trackFeature("attachment", humanCaller() ? "human" : "agent", transfer.id);
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
        trackFeature("attachment", humanCaller() ? "human" : "agent");
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
      await refreshThreadNotifications("read");
      if (currentNotificationPolicy() === null) return error("Canonical manager notification policy is unavailable", 503);
      if (url.searchParams.get("history") === "1") {
        const before = url.searchParams.has("before") ? Number(url.searchParams.get("before")) : null;
        if (before !== null && (!Number.isSafeInteger(before) || before <= 0)) return error("Invalid history cursor");
        return json(await resolveNotificationQuestions(notificationHistory(db, before, notificationThread, 100, currentNotificationPolicy()), readSessionQuestions));
      }
      return json({ environmentId: ENVIRONMENT_ID, ...idleNotifications(db, after, notificationThread, currentNotificationPolicy()), policy: currentNotificationPolicy() });
    }
    if (API.workspaces.match(req.method, url.pathname)) {
      return json({ workspaces: [...workspaces.values()] });
    }
    if (API.reconcile.match(req.method, url.pathname)) {
      const patch = readSubscription(await readBody(req));
      if (patch.viewing && !humanCaller()) return error("Human viewing requires an authenticated person", 403);
      const events: StreamWireEvent[] = [];
      const stream = new ClientStream({
        write: chunk => { events.push(JSON.parse(chunk.slice(chunk.indexOf("data: ") + 6).trim())); },
        close: () => {},
      }, reconciledState);
      const abort = () => stream.close();
      req.signal.addEventListener("abort", abort, { once: true });
      try {
        stream.send({ type: "hello", epoch: SUPERVISOR_EPOCH, streamId: stream.id, bootstrap: bootstrap() });
        void refreshPeers();
        await applySubscription(stream, patch, "finite");
        return json({ events });
      } finally {
        req.signal.removeEventListener("abort", abort);
        stream.close();
      }
    }
    if (API.stream.match(req.method, url.pathname)) {
      const patch = readSubscription(await readBody(req).catch(() => ({})));
      if (patch.viewing && !humanCaller()) return error("Human viewing requires an authenticated person", 403);
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
        pushNotifications(stream);
        stream.ping();
      }, PING_INTERVAL_MS);
      req.signal.addEventListener("abort", () => { clearInterval(ping); closeStream(stream); }, { once: true });
      const facts = bootstrap();
      bootstrapEncoded = JSON.stringify(facts);
      stream.send({ type: "hello", epoch: SUPERVISOR_EPOCH, streamId: stream.id, bootstrap: facts });
      void applySubscription(stream, patch, "push").catch((cause) => {
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
        const patch = readSubscription(await readBody(req));
        if ((patch.viewing ?? stream.subscription.viewing) && !humanCaller()) return error("Human viewing requires an authenticated person", 403);
        await applySubscription(stream, patch, "push");
        return new Response(null, { status: 204, headers: API_CORS_HEADERS });
      } catch (cause: any) { return error(cause?.message ?? "Could not update the stream", 400); }
    }
    const errorDismissal = API.dismissError.match(req.method, url.pathname);
    if (errorDismissal) {
      if (dismissError(db, errorDismissal.errorId)) signalSync();
      return json({ ok: true });
    }
    if (API.sessions.match(req.method, url.pathname)) {
      if (url.searchParams.get("allAgents") === "1") {
        await refreshPeers();
        if (peerError) return error(`Could not load the complete agent directory: ${peerError}`, 503);
      } else void refreshPeers();
      projectState();
      return json(currentState());
    }
    if (API.archivedSessions.match(req.method, url.pathname)) {
      await refreshPeers();
      const page = await archivedSessionPage(url.searchParams);
      return page.ok ? json(page.value) : threadError(page.error);
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
        if (body.meetingId !== undefined) return error("Use external meeting participation to create a meeting thread");
        const model = String(body.model ?? destination.defaultModel);
        if (!destination.models.includes(model)) return error("Model not available at this destination");
        const id = String(body.sessionId ?? requestId);
        const contextFiles = selectContextFiles(destinationContextSources(destination), body.contextFiles);
        if (!contextFiles.ok) return error(contextFiles.error);
        const creator = await admissionFor(callers, caller)("spawn", { parentId: body.parentId ?? undefined });
        if (!creator.ok) return error(creator.message, creator.status);
        const thread = await insertThread(id, creationName(requestId), destination, model, null, body.message, body.parentId,
          { thinkingLevel: body.thinkingLevel, speed: body.speedMode },
          contextFiles.value, creator.input.createdBy);
        const response = { session: publicSession(threadRow(thread)) };
        saveRequest(requestId, id, "create", 201, response);
        trackFeature("agents", humanCaller() ? "human" : "agent", requestId);
        return json(response, 201);
      } catch (cause: any) { return error(cause.message); }
    }
    const questionsRequest = API.sessionQuestions.match(req.method, url.pathname);
    if (questionsRequest) {
      if (!sessionRow.get(questionsRequest.sessionId)) return error("Session not found", 404);
      const result = await readSessionQuestions(questionsRequest.sessionId);
      return result.ok ? json({ questions: result.value }) : threadError(result.error);
    }
    const answerRequest = API.sessionQuestionAnswer.match(req.method, url.pathname);
    if (answerRequest) {
      if (!sessionRow.get(answerRequest.sessionId)) return error("Session not found", 404);
      try {
        const body = await readBody(req);
        const result = await directory.answer({ threadId: answerRequest.sessionId, questionId: answerRequest.questionId, humanActivity: humanCaller(),
          selectedSuggestionIds: body?.selectedSuggestionIds, text: body?.text, dismissed: body?.dismissed });
        if (!result.ok) return threadError(result.error);
        await questionFeed.settle(answerRequest.sessionId);
        for (const stream of sessionSubscribers(answerRequest.sessionId)) void sendQuestions(stream);
        signalSync();
        return json(result.value);
      } catch (cause: any) { return error(cause?.message ?? "Could not answer question", 400); }
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
      const before = unwrap(await directory.inspect(sessionId, { context: "omit" }));
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
      ["unarchive", API.unarchiveSession], ["placement", API.sessionPlacement], ["color", API.sessionColor], ["prompt", API.sessionPrompt], ["fork", API.sessionFork], ["abort", API.sessionAbort], ["resume", API.sessionResume],
      ["events", API.sessionEvents], ["context", API.sessionContext], ["settings", API.sessionSettings], ["settings", API.updateSessionSettings],
      ["commands", API.sessionCommands], ["command", API.sessionCommand], ["admission", API.sessionAdmission],
    ];
    const sessionMatch = sessionRoutes.map(([action, route]) => ({ action, params: route.match(req.method, url.pathname) }))
      .find((candidate) => candidate.params !== null);
    if (!sessionMatch?.params) return error("Not found", 404);
    const id = sessionMatch.params.sessionId;
    const action = sessionMatch.action;
    const row = sessionRow.get(id) as any;
    if (action === "prompt" && req.method === "POST") {
      let body: unknown;
      try { body = await readBody(req); }
      catch (cause) { return json({ outcome: "rejected", error: cause instanceof Error ? cause.message : "Invalid prompt JSON", code: "invalid_request" }, 400); }
      if (body && typeof body === "object" && "requestId" in body && typeof body.requestId === "string" && !promptAdmissions.has(body.requestId) && requestResult(body.requestId)) {
        return json({ outcome: "rejected", error: "requestId already belongs to another operation", code: "conflict" }, 409);
      }
      const result = await promptAdmissions.submit(id, body, {
        prepare: async input => {
          if (!row) return { ok: false, error: { code: "not_found", message: "Session not found" } };
          if (ROOMS_ENABLED && roomMetadata(row.metadata?.room)) return { ok: false, error: { code: "forbidden", message: "Use the room API for room messages" } };
          if (row.archived_at) return { ok: false, error: { code: "conflict", message: "Thread is archived" } };
          if (forkingSessions.has(id)) return { ok: false, error: { code: "conflict", message: "Wait for the conversation edit to finish" } };
          const roomImages = input.includeMeetingImages === true && row.meeting_id
            ? await meet.captureDelegation(row.meeting_id) : { images: [], note: "" };
          let text = input.text.trim() + (roomImages.note ? `\n\n${roomImages.note}` : "");
          if (input.replyTo !== undefined) {
            const target = parseMessageReference(input.replyTo);
            if (target?.transport !== "pi" || target.sessionId !== id) return { ok: false, error: { code: "invalid_request", message: "Reply must reference a message in this conversation" } };
            const history = await directory.read({ threadId: id, entryId: target.messageId });
            if (!history.ok) return history;
            const reply = replyFromNativeEntry(input.replyTo, history.value.entries[0], MESSAGE_OWNER, AGENT_NAME);
            if (!reply) return { ok: false, error: { code: "invalid_request", message: "Reply target is not a user or assistant message" } };
            text = encodeMessageReply(text, reply);
          }
          return { ok: true, value: { text, delivery: input.delivery, images: roomImages.images } };
        },
        send: async (threadId, requestId, prepared) => {
          if (req.signal.aborted) return { ok: false, error: { code: "unavailable", message: "The caller disconnected before admission; check the saved request explicitly." } };
          return directory.send({ threadId, requestId, ...prepared, humanActivity: humanCaller() });
        },
      });
      if (result.body.outcome === "accepted" && body && typeof body === "object" && "requestId" in body && typeof body.requestId === "string") trackFeature("chat", humanCaller() ? "human" : "agent", body.requestId);
      return json(result.body.outcome === "accepted" && row ? { ...result.body, session: publicSession(row) } : result.body, result.status);
    }
    if (ROOMS_ENABLED && roomMetadata(row?.metadata?.room) && ["prompt", "fork", "command"].includes(action ?? "")) return error("Use the room API for room messages", 403);
    if (!row) return error("Session not found", 404);
    if (!action && req.method === "GET") return json({ session: publicSession(row) });
    if (action === "unarchive" && req.method === "POST") {
      if (!humanCaller()) return error("Only a person can open an agent in Chats", 403);
      const result = await directory.control({ threadId: id, action: "open" });
      return result.ok ? json({ ok: true, session: publicSession(threadRow(result.value)) }) : threadError(result.error);
    }
    if (action === "placement" && req.method === "PUT") {
      if (!humanCaller()) return error("Only a person can change foreground placement", 403);
      const body = await readBody(req);
      if (typeof body.foreground !== "boolean") return error("Placement requires a foreground boolean");
      const result = await directory.control({ threadId: id, action: "placement", foreground: body.foreground });
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
      const view = url.searchParams.get("view");
      if (view !== null && view !== "current") return error("Unknown context view", 400);
      if (view === "current") {
        if (url.searchParams.has("leafId")) return error("Current runtime context cannot select a historical branch", 400);
        if (row.state !== "running") return error("Current context requires an active runtime", 409);
        const inspected = await directory.inspect(id, { context: "full" });
        if (!inspected.ok) return threadError(inspected.error);
        return json({ context: inspected.value.context, session: publicSession(sessionRow.get(id)) });
      }
      return contextResponse(publicSession(sessionRow.get(id)), req, async (after, limit, revision) => {
        const inspected = await directory.inspect(id, { contextRecords: { ...(after === undefined ? {} : { after }), limit, includeEntries: true,
          ...(revision === undefined ? {} : { revision }),
          ...(url.searchParams.has("leafId") ? { leafId: url.searchParams.get("leafId")! } : {}) } });
        if (!inspected.ok) return inspected;
        return inspected.value.contextRecords ? { ok: true, value: inspected.value.contextRecords }
          : { ok: false, error: { code: "invalid_source", message: "The thread owner did not return native records" } };
      }, API_CORS_HEADERS);
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
        const result = await runCommand(row, requestId, name, args, humanCaller());
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
    if (action === "abort" && req.method === "POST") {
      const body = await readBody(req);
      if (body.descendants !== false) return error("Cancellation targets only the selected agent; descendants must be false");
      const result = await directory.control({ threadId: id, action: "cancel" });
      return result.ok ? json({ ok: true, session: publicSession(threadRow(result.value)) }) : threadError(result.error);
    }
    if (action === "resume" && req.method === "POST") {
      const result = await directory.control({ threadId: id, action: "resume" });
      return result.ok ? json({ ok: true, session: publicSession(threadRow(result.value)) }) : threadError(result.error);
    }

    return error("Not found", 404);
    })());
  },
  websocket: {
    perMessageDeflate: false,
    maxPayloadLength: PHONE_MAX_FRAME_BYTES,
    backpressureLimit: PHONE_MAX_FRAME_BYTES,
    idleTimeout: 45,
    sendPings: true,
    closeOnBackpressureLimit: false,
    open(socket) {
      if (socket.data.kind === "phone") { socket.data.connection = phones.open({ send: frame => socket.send(frame), close: (code, reason) => socket.close(code, reason) }); return; }
      socket.close(1008, "Unsupported WebSocket kind");
    },
    message(socket, message) {
      if (socket.data.connection) phones.receive(socket.data.connection, message);
    },
    close(socket) {
      if (socket.data.connection) phones.disconnected(socket.data.connection);
    },
  },
});
console.log(`Pi Remote listening on http://${server.hostname}:${server.port}`);

// The retired journal's facts moved during startup. Removing what is left is
// slow enough to matter to an activation handshake and to a request in flight,
// and urgent to nobody, so it happens a slice at a time between requests.
const journalRemoval = setInterval(() => {
  if (shuttingDown) return;
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

signalSync();
unwrap(await threads.start());
watchList.start();
const unreadThread = db.query("SELECT idle_unread FROM thread_views WHERE id=?");
const stopAutoArchive = startAutoArchive(directory, AUTO_ARCHIVE_AFTER_MS, error => console.error("[supervisor] auto-archive failed", error), thread => Boolean((unreadThread.get(thread.id) as { idle_unread: number } | null)?.idle_unread),
  thread => typeof thread.metadata?.meetingId === "string" && meet.isLive(thread.metadata.meetingId));
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
  if (statePushTimer) clearTimeout(statePushTimer);
  statePushTimer = null;
  stateSyncPending = false;
  if (liveSyncTimer) clearTimeout(liveSyncTimer);
  liveSyncTimer = null;
  liveSyncPending = false;
  clearInterval(journalRemoval);
  unwatchFile(modelAvailability.path);
  watchList.stop();
  stopAutoArchive();
  clearInterval(uploadPruner);
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
    phones.stop();
    stopSupervisorTimers();
    unsubscribeThreads();
    threads.suspend();
    runner.detach();
  },
  detach: () => threads.detach(),
  closeImages: async () => { await calendar.close(); await watchList.close(); speech?.close(); await messaging.close(); await closeImageGeneration(); },
  stopServer: () => { server.stop(true); },
  closeDatabase: () => db.close(),
  exit: code => process.exit(code),
});
async function releaseSupervisor(exitCode: number) {
  const result = await supervisorRelease.release(exitCode);
  if (!result.ok) console.error("Supervisor handoff failed:", result.error);
}

process.on("SIGTERM", () => void releaseSupervisor(0));
process.on("SIGINT", () => void releaseSupervisor(0));
process.on("SIGUSR2", () => void releaseSupervisor(75));
process.on("SIGHUP", () => void releaseSupervisor(75));
stateSyncPhase = "ready";
if (stateSyncPending) signalSync();
