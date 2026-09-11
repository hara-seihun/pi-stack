// The wire shapes both clients and the supervisor agree on. Server modules
// import these types and produce values that satisfy them; the React client
// imports the same file, so a field renamed on one side fails to compile on
// the other instead of silently reading undefined at runtime.

import type { InlineImage, InlineImageSnapshot } from "./inline-image-contract";
export type { InlineImage, InlineImageSnapshot };

export type ContextSplice = {
  baseHash: string;
  targetHash: string;
  prefixBytes: number;
  deleteBytes: number;
  insertBase64: string;
};

export type DocumentUpdate =
  | { kind: "full"; capturedAt: number; hash: string; document: string }
  | { kind: "splice"; capturedAt: number; hash: string; splice: ContextSplice }
  | { kind: "clear"; capturedAt: 0; hash: "" };

export type Activity =
  | "IDLE" | "FAILED" | "STARTING" | "ABORTING" | "RUNNING" | "WORKING" | "THINKING"
  | "COMPACTING" | "RETRYING" | "QUEUED" | "WAITING_ON_TOOL" | (string & {});

export interface IdleNotification { seq: number; sessionId: string; name: string; time: string }
export interface IdleNotificationFeed { cursor: number; notifications: IdleNotification[] }

export interface QueuedMessage {
  id: string;
  text: string;
  delivery: string;
  state: string;
  status: string;
  canSteer: boolean;
  canHardSteer: boolean;
  canCancel: boolean;
  createdAt: string;
  lastError: string | null;
}

export interface Session {
  id: string;
  name: string;
  cwd: string;
  workspaceName: string;
  environment: string;
  state: string;
  activity: Activity;
  activeTool: string | null;
  provider: "anthropic" | "openai";
  createdAt: string;
  updatedAt: string;
  revision: number;
  lastError: string | null;
  steeringQueued: number;
  followUpQueued: number;
  queuedMessages: QueuedMessage[];
  archivedAt: string | null;
}

export interface SessionEvent {
  seq: number;
  time: string;
  type: string;
  [key: string]: unknown;
}

export interface AgentHostRef {
  key: string;
  label: string;
  name: string;
}

export interface AgentHostStatus extends AgentHostRef {
  running: number;
  updatedAt: string | null;
  error: string | null;
}

export interface AgentRun {
  id: string;
  host: string;
  hostLabel: string;
  hostName: string;
  runId: string;
  taskId: string;
  model: string;
  thinking: string;
  provider: string;
  label: string;
  key: string;
  status: string;
  activity: Activity;
  activeTool: string | null;
  startedAt: string;
  finishedAt: string | null;
  observable: boolean;
  error: string | null;
}

export interface AgentRunEvent {
  seq: number;
  time: string;
  type: string;
  [key: string]: unknown;
}

export interface PlanMetricRow {
  id: string;
  model: string;
  modelLabel: string;
  text: string;
  cacheText: string;
  description: string;
}

export interface PlanCard {
  id: string;
  label: string;
  icon: string;
  state: string;
  text: string;
  description: string;
  metrics: PlanMetricRow[];
}

export type GovernorProvider = "openai" | "anthropic";
/** The drawer button's four states, in cycle order: normal pace, 3× (green),
 * 10× (blue), and background halted (red). Forced runs bypass these controls;
 * running sessions finish naturally. */
export type GovernorState = "off" | "green" | "blue" | "red";
export interface Governor {
  state: GovernorState;
  boosted: boolean;
  multiplier: number;
  boostedMultiplier: number;
}
export type GovernorControls = Record<GovernorProvider, Governor>;

export interface MachineActionState {
  id: string;
  label: string;
  icon: string;
  active: boolean;
}

export interface MachineUsage {
  cpuPercent: number | null;
  gpuPercent: number | null;
  memory: { usedBytes: number; totalBytes: number; percentUsed: number };
  disk: { usedBytes: number; totalBytes: number; availableBytes: number; percentUsed: number } | null;
}

export interface ThreadStartModel {
  id: string;
  label: string;
  icon: string;
  accent?: string;
}

export interface ThreadStart {
  id: string;
  label: string;
  icon: string;
  accent?: string;
  defaultModel?: string;
  models: ThreadStartModel[];
}

export interface AgentModelCount {
  key: string;
  label: string;
  count: number;
}

/** Everything in the drawer footer and the Orchestrator tab. It changes on
 * its own clock (meters, load, agent lifecycles), so it has its own version. */
export interface Dashboard {
  plans: PlanCard[];
  governors: GovernorControls | null;
  actions: MachineActionState[];
  machine: MachineUsage | null;
  agents: { runs: AgentRun[]; hosts: AgentHostStatus[]; running: number };
  modelCounts: AgentModelCount[];
  threadStarts: ThreadStart[];
  home: string;
}

/** Durable supervisor state: every thread the drawer lists. Changes whenever
 * SQLite changes or the supervisor signals an in-memory transition. */
export interface SupervisorState {
  sessions: Session[];
  archived: Session[];
  archivedTotal: number;
}

export interface SyncRequest {
  epoch?: string;
  /** Last wake sequence seen; the poll parks until it moves. */
  seq?: number;
  waitMs?: number;
  /** Omit a version to skip that section entirely; send 0 to force it. */
  stateVersion?: number;
  dashboardVersion?: number;
  session?: {
    id: string;
    contextHash?: string;
    /** Last image snapshot version. Omit to request the full current snapshot. */
    imagesVersion?: number;
    liveTextHash?: string;
    liveThinkingHash?: string;
    /** Durable event cursor; omit when the caller renders from context. */
    eventsAfter?: number;
  };
  agent?: {
    id: string;
    after?: number;
    liveTextHash?: string;
    liveThinkingHash?: string;
  };
}

export interface SyncResponse {
  epoch: string;
  seq: number;
  stateVersion: number;
  dashboardVersion: number;
  /** Present only when the caller's stateVersion is behind. */
  state: SupervisorState | null;
  /** Present only when the caller's dashboardVersion is behind. */
  dashboard: Dashboard | null;
  /** Present whenever a session was requested and still exists. Each
   * document is null when the caller's hash already matches. */
  session: {
    context: DocumentUpdate | null;
    images: InlineImageSnapshot | null;
    liveText: DocumentUpdate | null;
    liveThinking: DocumentUpdate | null;
    events: SessionEvent[];
  } | null;
  agent: {
    run: AgentRun;
    events: AgentRunEvent[];
    liveText: DocumentUpdate | null;
    liveThinking: DocumentUpdate | null;
  } | null;
}

export const BASH_TIMEOUT_OPTIONS = [60, 300, 1800] as const;
export type BashTimeoutSeconds = (typeof BASH_TIMEOUT_OPTIONS)[number];
export const DEFAULT_BASH_TIMEOUT_SECONDS: BashTimeoutSeconds = 1800;

export interface ThreadSettings {
  models: Array<{ id: string; name?: string; provider: string; common?: boolean }>;
  model: { id: string; provider: string } | null;
  thinkingLevels: string[];
  thinkingLevel: string | null;
  speedModes: string[];
  speedMode: string | null;
  bashTimeoutSeconds: BashTimeoutSeconds;
}

export interface SlashCommand {
  name: string;
  description?: string;
  source?: string;
}
