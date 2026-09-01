import type { ModelCandidate } from "./catalog.js";

export type BudgetClass = "background" | "force";
export type RunSource = "direct" | "lane" | "room";
export type RunState = "queued" | "starting" | "running" | "parked" | "done" | "failed" | "aborted";
export type LeaseKind = "fleet" | "interactive" | "voice";
export type FailureKind = "provider" | "account" | "infrastructure" | "operator" | "task";

export interface Account {
  readonly id: string;
  readonly provider: "openai-codex" | "anthropic";
  readonly label?: string;
  readonly enabled: boolean;
  readonly cooldownUntil?: number;
  readonly concurrency: number;
}

export interface LaneSpec {
  readonly id: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly profile: string;
  readonly weight: number;
  readonly fixedDemand?: number;
  readonly priority?: number;
  readonly doctrineUrl?: string;
  readonly openingProbe?: string;
}

export interface DemandSnapshot {
  readonly revision: string;
  readonly lanes: Readonly<Record<string, { readonly count: number; readonly priority?: number }>>;
}

export interface LaneManifest {
  readonly version: 2;
  readonly snapshotCommand?: string;
  readonly lanes: readonly (LaneSpec | (Omit<LaneSpec,"prompt"> & { readonly promptFile:string }))[];
}

export interface Run {
  readonly id: string;
  readonly source: RunSource;
  readonly sourceId?: string;
  readonly roomId?: string;
  readonly memberName?: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly profile: string;
  readonly budget: BudgetClass;
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

export interface OrchestratorConfig {
  readonly profiles: Readonly<Record<string, readonly ModelCandidate[]>>;
  readonly backgroundSpendFraction: number;
  readonly maxConcurrentSessions: number;
  readonly defaultAccountConcurrency: number;
  readonly meterMaxAgeMs: number;
  readonly snapshotIntervalMs: number;
  readonly reconcileIntervalMs: number;
  readonly stallAfterMs: number;
  readonly killAfterMs: number;
  readonly taskManifest?: string;
  readonly authPath: string;
  readonly agentDir: string;
}
