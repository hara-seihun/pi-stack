import type { ModelCandidate } from "./catalog.js";

export type BudgetClass = "background" | "force";
export type RunSource = "direct" | "lane";
export const ISOLATED_TOOLS = ["read", "write", "edit", "bash", "grep", "find", "ls", "agent_browser"] as const;
export type RunContext = { readonly tools: readonly string[]; readonly extensions?: readonly string[] };
export type RunState = "queued" | "starting" | "running" | "waiting" | "done" | "failed" | "aborted";
export const FLEET_MODELS = ["astra", "sol", "terra", "luna"] as const;
export type FleetModel = typeof FLEET_MODELS[number];
export interface FleetDispatch {
  readonly requestId: string;
  readonly task: string;
  readonly model: FleetModel;
  readonly escalatesRunId?: string;
}
export interface FleetChild extends FleetDispatch {
  readonly parentRunId: string;
  readonly rootRunId: string;
  readonly assignment: ModelCandidate;
}
export interface FleetResult {
  readonly deliveryId: string;
  readonly runId: string;
  readonly parentRunId: string;
  readonly model: string;
  readonly state: "done" | "failed" | "aborted";
  readonly result: string;
  readonly failureKind?: FailureKind;
  readonly sessionFile?: string;
}
export type LeaseKind = "fleet" | "interactive" | "voice";
export type FailureKind = "provider" | "account" | "infrastructure" | "operator" | "task";
export type RunActivity = "IDLE" | "STARTING" | "WORKING" | "THINKING" | "COMPACTING" | "WAITING_ON_TOOL";

export interface Account {
  readonly id: string;
  readonly provider: "openai-codex" | "anthropic";
  readonly label?: string;
  readonly enabled: boolean;
  readonly cooldownUntil?: number;
  readonly concurrency: number;
  readonly use?: "shared" | "voice";
}

export function allowsAccountUse(account: Account, kind: LeaseKind): boolean {
  return account.enabled && (account.use !== "voice" || kind === "voice");
}

export interface LaneSpec {
  readonly id: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly profile: string;
  readonly weight: number;
  readonly priority?: number;
  readonly doctrineUrl?: string;
  readonly openingProbe?: string;
}

export interface LaneReadiness {
  readonly revision:string;
  readonly lanes:Readonly<Record<string,{readonly ready:boolean}>>;
}

export interface LaneManifest {
  readonly version: 2;
  readonly budget?: BudgetClass;
  readonly snapshotCommand?:string;
  readonly lanes: readonly (LaneSpec | (Omit<LaneSpec,"prompt"> & { readonly promptFile:string }))[];
}

export interface Run {
  readonly id: string;
  readonly source: RunSource;
  readonly sourceId?: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly profile: string;
  readonly budget: BudgetClass;
  readonly context?: RunContext;
  readonly parentRunId?: string;
  readonly rootRunId?: string;
  readonly childRunIds?: readonly string[];
  readonly requestedModel?: FleetModel;
  readonly escalatesRunId?: string;
  readonly deliveryState?: "pending" | "delivered";
  readonly accountId?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly sessionFile?: string;
  readonly state: RunState;
  readonly failureKind?: FailureKind;
  readonly result?: string;
  readonly workerUnit?: string;
  readonly releasePath?: string;
  readonly createdAt: number;
  readonly startedAt?: number;
  readonly updatedAt: number;
  readonly progressAt?: number;
  readonly endedAt?: number;
}

/** The parts a provider reports for one assistant message. */
export type UsageComponent = "input" | "output" | "cacheRead" | "cacheWrite";

export interface UsageEntry {
  readonly accountId: string;
  readonly hour: number;
  readonly source: string;
  readonly runId: string;
  readonly model: string;
  readonly component: UsageComponent;
  readonly tokens: number;
}

export type UsageTotal = Pick<UsageEntry, "accountId" | "model" | "component" | "tokens">;

export type ProfileCandidate = Omit<ModelCandidate, "thinking"> & (
  | { readonly thinking?: string; readonly thinkingPair?: never }
  | { readonly thinking?: never; readonly thinkingPair: readonly [string, string] }
);

export interface OrchestratorConfig {
  readonly listenHost?: string;
  readonly profiles: Readonly<Record<string, readonly ProfileCandidate[]>>;
  readonly backgroundSpendFraction: number;
  readonly maxConcurrentSessions: number;
  readonly defaultAccountConcurrency: number;
  readonly meterMaxAgeMs: number;
  readonly reconcileIntervalMs: number;
  readonly stallAfterMs: number;
  readonly killAfterMs: number;
  readonly taskManifest?: string;
  readonly authPath: string;
  readonly agentDir: string;
}
