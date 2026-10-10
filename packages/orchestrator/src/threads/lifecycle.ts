import { validateWaitDependency, type AgentWait } from "./contracts.js";
import { EXECUTION_PHASES, type ExecutionActivitySnapshot, type ExecutionPhase } from "./execution-activity.js";

export type ThreadLifecycle =
  | { kind: "idle" }
  | { kind: "archived" }
  | { kind: "working"; phase: ExecutionPhase; since: number; detail?: string }
  | { kind: "cancelling" }
  | { kind: "waiting"; target: "capacity" | "retry"; reason: string; since: number }
  | { kind: "waiting"; target: "agents" | "job" | "deployment" | "message" | "dispatch"; since: number; dependency?: AgentWait }
  | { kind: "failed"; reason: string; control: "stop" | "cancel_wait" | "none" };

export function isThreadLifecycle(input: unknown): input is ThreadLifecycle {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const value = input as Record<string, unknown>;
  const since = typeof value.since === "number" && Number.isFinite(value.since);
  const text = (input: unknown) => typeof input === "string" && !!input.trim();
  switch (value.kind) {
    case "idle": case "archived": case "cancelling": return true;
    case "working": return since && EXECUTION_PHASES.some(phase => phase === value.phase)
      && (value.detail === undefined || typeof value.detail === "string");
    case "failed": return text(value.reason) && ["stop", "cancel_wait", "none"].includes(value.control as string);
    case "waiting": {
      if (!since) return false;
      if (value.target === "capacity" || value.target === "retry") return text(value.reason);
      if (!["agents", "job", "deployment", "message", "dispatch"].includes(value.target as string)) return false;
      if (value.dependency === undefined) return true;
      const dependency = value.dependency as AgentWait;
      return validateWaitDependency(dependency).ok && dependency.kind === value.target && Number.isFinite(dependency.since);
    }
    default: return false;
  }
}

export type LifecycleObservation = {
  archived: boolean;
  cancelling: boolean;
  execution: { since: number; activity: ExecutionActivitySnapshot } | null;
  pending: { since: number } | null;
  delay: { target: "capacity" | "retry"; since: number; reason: string } | null;
  dependency: AgentWait | null;
  subscriptions: string[];
  error: string | null;
  updatedAt: number;
};

/** Runnable input, execution custody and future schedules are different facts. */
export function deriveThreadLifecycle(source: LifecycleObservation): ThreadLifecycle {
  const { execution, pending, dependency } = source;
  const phase = execution?.activity.activity;
  const control = execution && !source.delay ? "stop" : pending || dependency || source.subscriptions.length || source.delay ? "cancel_wait" : "none";
  if (source.error && !source.delay) return { kind: "failed", reason: source.error, control };
  if (source.cancelling && execution) return { kind: "cancelling" };
  if (source.archived) return { kind: "archived" };
  if (source.cancelling) return { kind: "idle" };
  if (source.delay) return { kind: "waiting", ...source.delay };
  if (execution) {
    if (!phase) return { kind: "failed", reason: "Execution owner did not report its activity", control: "stop" };
    return { kind: "working", phase, since: execution.activity.activitySince ?? execution.since, ...(execution.activity.activityDetail ? { detail: execution.activity.activityDetail } : {}) };
  }
  if (pending) return { kind: "waiting", target: "dispatch", since: pending.since };
  if (dependency) {
    if (!validateWaitDependency(dependency).ok || !Number.isFinite(dependency.since)) return { kind: "failed", reason: "Invalid owned dependency wait", control: "cancel_wait" };
    return { kind: "waiting", target: dependency.kind, since: dependency.since, dependency };
  }
  if (source.subscriptions.length) return { kind: "waiting", target: "agents", since: source.updatedAt };
  return { kind: "idle" };
}

export function lifecycleControl(lifecycle: ThreadLifecycle): "stop" | "cancel_wait" | "none" {
  switch (lifecycle.kind) {
    case "working": return "stop";
    case "waiting": return "cancel_wait";
    case "failed": return lifecycle.control;
    case "idle": case "archived": case "cancelling": return "none";
  }
}
