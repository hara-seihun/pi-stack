import type { Activity, GovernorState, Session, StreamSnapshot, TranscriptItemKind } from "../server/protocol.js";
import { assertNever, requireState } from "./explicit-state.js";

export const ACTIVITIES = {
  idle: true, awaiting: true, status_error: true,
  queued: true, admitting: true, starting: true, preparing: true, finishing: true, cancelling: true, recovering: true,
  thinking: true, responding: true, preparing_tool: true, waiting_for_model: true, waiting_on_agents: true,
  waiting_on_tool: true, compacting: true, retrying: true, waiting_for_capacity: true, waiting_to_retry: true,
} satisfies Record<Activity, true>;
const THREAD_STATES = { idle: true, running: true, waiting: true } satisfies Record<Session["state"], true>;
export const TRANSCRIPT_KINDS = { system: true, tool: true, user: true, assistant: true, thinking: true, toolCall: true, notice: true } satisfies Record<TranscriptItemKind, true>;
export const GOVERNOR_STATES = { off: true, green: true, blue: true, red: true } satisfies Record<GovernorState, true>;
const SNAPSHOT_TYPES = { bootstrap: true, state: true, dashboard: true, workers: true, transcript: true, live: true, images: true, questions: true } satisfies Record<StreamSnapshot["type"], true>;

export function stateObject(value: unknown, owner: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${owner}: expected object`);
  return value as Record<string, unknown>;
}
export function stateArray(value: unknown, owner: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${owner}: expected array`);
  return value;
}
export function stateString(value: unknown, owner: string): string {
  if (typeof value !== "string") throw new Error(`${owner}: expected string`);
  return value;
}

export function validateThreadObservation(value: unknown): void {
  const row = stateObject(value, "Thread observation");
  requireState(row.state, THREAD_STATES, "Thread lifecycle");
  requireState(row.activity, ACTIVITIES, "Thread activity");
}

export function validateSession(value: unknown): asserts value is Session {
  validateThreadObservation(value);
  const row = stateObject(value, "Session");
  stateString(row.id, "Session id");
  if (row.taskDescription !== undefined) {
    const description = stateString(row.taskDescription, "Task description");
    if (!description.trim() || description.length > 240) throw new Error("Task description: expected 1..240 characters");
  }
  requireState(row.origin, { person: true, fleet: true } satisfies Record<Session["origin"], true>, "Session origin");
  if (typeof row.held !== "boolean") throw new Error("Session held: expected boolean");
  stateArray(row.activeTools, "Active tools").forEach(tool => stateString(tool, "Active tool"));
  stateArray(row.queuedMessages, "Queued messages").forEach(value => {
    const message = stateObject(value, "Queued message");
    requireState(message.state, { queued: true, dispatched: true } satisfies Record<Session["queuedMessages"][number]["state"], true>, "Queued message state");
    requireState(message.delivery, { queue: true, steer: true, hardSteer: true } satisfies Record<Session["queuedMessages"][number]["delivery"], true>, "Queued message delivery");
    if (message.acknowledgement !== undefined) requireState(message.acknowledgement, { pending: true, unconfirmed: true }, "Message acknowledgement");
  });
  if (row.waitingOnAgents !== undefined) {
    const wait = stateObject(row.waitingOnAgents, "Dependency wait");
    if (!Object.hasOwn(wait, "kind")) {
      if (row.activity !== "status_error") throw new Error("Dependency wait: wait type missing");
    } else {
      const kind = requireState(wait.kind, { agents: true, job: true, deployment: true, message: true } satisfies Record<NonNullable<Session["waitingOnAgents"]>["kind"], true>, "Dependency wait");
      stateString(wait.reason, "Wait reason");
      switch (kind) {
        case "agents":
          if (!stateArray(wait.threadIds, "Agent dependencies").length) throw new Error("Agent wait: dependencies are empty");
          (wait.threadIds as unknown[]).forEach(id => stateString(id, "Agent dependency"));
          stateObject(wait.after, "Agent wait cursors");
          break;
        case "job": stateString(wait.jobId, "Job dependency"); break;
        case "deployment": stateString(wait.publicationId, "Deployment dependency"); break;
        case "message": stateString(wait.fromThreadId, "Message dependency"); break;
      }
    }
  }
}

export function validateTranscriptHead(value: unknown): void {
  const head = stateObject(value, "Transcript head");
  requireState(head.kind, TRANSCRIPT_KINDS, "Transcript kind");
  if (head.textTruncated !== undefined && (head.textTruncated !== true || !["user", "assistant", "notice"].includes(String(head.kind))))
    throw new Error("Transcript text preview: invalid marker");
}
export function validateStreamSnapshot(resource: string, value: unknown): asserts value is StreamSnapshot {
  const snapshot = stateObject(value, "Stream snapshot");
  const type = requireState(snapshot.type, SNAPSHOT_TYPES, "Stream snapshot type");
  const scoped = type === "transcript" || type === "live" || type === "images" || type === "questions";
  const expected = scoped ? `${type}:${stateString(snapshot.sessionId, "Snapshot session")}` : type;
  if (resource !== expected) throw new Error(`Stream resource ${resource} does not match ${expected}`);
  switch (type) {
    case "state": case "workers": stateArray(snapshot.sessions, `${type} sessions`).forEach(validateSession); return;
    case "transcript": stateArray(snapshot.items, "Transcript items").forEach(validateTranscriptHead); return;
    case "live": stateString(snapshot.text, "Live text"); return;
    case "images": {
      const images = stateObject(snapshot.snapshot, "Image snapshot");
      stateArray(images.images, "Inline images").forEach(value => {
        const image = stateObject(value, "Inline image");
        requireState(image.state, { queued: true, generating: true, complete: true, error: true }, "Inline image state");
      });
      return;
    }
    case "questions":
      requireState(snapshot.state, { loading: true, ready: true, failed: true }, "Questions resource state");
      stateArray(snapshot.questions, "Questions");
      if (snapshot.state === "failed") stateString(snapshot.error, "Questions error");
      return;
    case "bootstrap": stateObject(snapshot.bootstrap, "Bootstrap"); return;
    case "dashboard": {
      const dashboard = stateObject(snapshot.dashboard, "Dashboard");
      if (dashboard.governors) {
        const governors = stateObject(dashboard.governors, "Governors");
        for (const provider of ["openai", "anthropic"]) requireState(stateObject(governors[provider], "Governor").state, GOVERNOR_STATES, "Governor mode");
      }
      stateArray(dashboard.plans, "Plans").forEach(value => {
        const plan = stateObject(value, "Plan");
        stateArray(plan.metrics, "Plan metrics").forEach(value => {
          const metric = stateObject(value, "Plan metric");
          stateArray(metric.accounts, "Plan accounts").forEach(value => requireState(stateObject(value, "Plan account").state, { ready: true, stale: true, unavailable: true }, "Account reading"));
        });
      });
      return;
    }
  }
  assertNever(type, "Stream snapshot");
}
