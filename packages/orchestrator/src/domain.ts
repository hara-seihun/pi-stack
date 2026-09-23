import type { ModelCandidate } from "./catalog.js";
import type { AccountReservation } from "./admission-reservation.js";
import type { ThinkingLevel } from "./threads/contracts.js";

export type BudgetClass = "background" | "force";
export type RunSource = "direct" | "lane";
export type RunExecution = "user" | "root-repair";
export const ISOLATED_TOOLS = ["read", "write", "edit", "bash", "grep", "find", "ls", "agent_browser"] as const;
export type RunContext = { readonly tools: readonly string[]; readonly extensions?: readonly string[] };
export type RunState = "queued" | "starting" | "running" | "done" | "failed" | "aborted";
export type LeaseKind = "fleet" | "interactive" | "voice";
export type FailureKind = "provider" | "account" | "infrastructure" | "operator" | "task";

export interface Account {
  readonly id: string;
  readonly provider: "openai-codex" | "anthropic";
  readonly label?: string;
  readonly enabled: boolean;
  readonly cooldownUntil?: number;
  readonly concurrency: number;
  readonly use?: "shared" | "voice";
  readonly reservation?: AccountReservation;
}

export function allowsAccountUse(account: Account, kind: LeaseKind): boolean {
  return account.enabled && (account.use !== "voice" || kind === "voice") && (!account.reservation || kind === "fleet");
}

export interface LaneSpec {
  readonly id: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly profile: string;
  readonly weight: number;
  readonly priority?: number;
  readonly admission?: BudgetClass;
  /** Held by every worker this lane starts, instead of the model's default. */
  readonly thinkingLevel?: ThinkingLevel;
  readonly doctrineUrl?: string;
  readonly openingProbe?: string;
  readonly repair?: { readonly readinessCommand: string };
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
  readonly execution?: RunExecution;
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

/**
 * Rate-limit resets an account has banked. Redeeming one returns a quota
 * window to zero, so the balance is part of how much an account can still do,
 * not just how much it has left in the current window.
 */
export interface ResetCreditReading {
  /** When the balance was read. */
  readonly at: number;
  /** Resets available to spend right now. */
  readonly available: number;
  /** Expiry of the credit that perishes first, when the provider dates them. */
  readonly nextExpiresAt?: number;
}

export interface PeerHost {
  readonly sshHost: string;
  readonly returnRoute?: {
    readonly sshHost: string;
    readonly port: number;
  };
}

export interface OrchestratorConfig {
  readonly modelBrokerUrl?: string;
  readonly port?: number;
  readonly listenHost?: string;
  readonly peers: Readonly<Record<string, PeerHost>>;
  readonly profiles: Readonly<Record<string, readonly ModelCandidate[]>>;
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
