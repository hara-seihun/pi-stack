import { catalogAgentType, tailRange, type ObservedRun } from "pi-orchestrator/api";

export { tailRange };

// Read-only observation of autonomous pi-orchestrator agents. The orchestrator
// owns run state and live activity. Pi's session JSONL owns settled history.
// Pi Remote reads both through the orchestrator package and never writes agent state.

// Every host runs its own orchestrator, so a run id is only unique within its
// host. Clients address a run by the composite key and never assemble one
// themselves, so both parts are validated on the way back in.
const HOST_KEY = /^[a-z][a-z0-9-]{0,15}$/;
const RUN_ID = /^[0-9a-zA-Z_.-]{1,64}$/;

import type { AgentHostRef, AgentRun as AgentRunSummary, AgentRunEvent } from "./protocol";

export type { AgentHostRef, AgentRunSummary, AgentRunEvent };

export function runKey(host: string, runId: string): string {
  return `${host}:${runId}`;
}

export function parseRunKey(value: string): { host: string; runId: string } | null {
  const separator = value.indexOf(":");
  if (separator <= 0) return null;
  const host = value.slice(0, separator);
  const runId = value.slice(separator + 1);
  return HOST_KEY.test(host) && RUN_ID.test(runId) ? { host, runId } : null;
}

export function isRunId(value: string): boolean {
  return RUN_ID.test(value);
}

export interface AgentLiveState {
  activity?: string;
  liveText?: string;
  liveThinking?: string;
  activeTool?: string | null;
}

export type AgentRunRow = ObservedRun;

const RUNNING_ACTIVITY = "WORKING";
const MAX_BUFFERED_EVENTS = 400;
const MAX_DELIVERED_EVENTS = 150;

function iso(value: unknown): string {
  const millis = Number(value);
  return Number.isFinite(millis) && millis > 0 ? new Date(millis).toISOString() : new Date(0).toISOString();
}

function normalizedActivity(status: string, live: AgentLiveState | null): string {
  if (status === "starting") return "STARTING";
  if (status !== "running") return "IDLE";
  const activity = String(live?.activity ?? RUNNING_ACTIVITY).trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (["RUNNING", "RESPONDING", "RESUMING", "SETTLING"].includes(activity)) {
    return live?.liveThinking && !live.liveText ? "THINKING" : "WORKING";
  }
  if (activity === "TOOL") return "WAITING_ON_TOOL";
  return activity || RUNNING_ACTIVITY;
}

export function summarizeAgentRun(row: AgentRunRow, host: AgentHostRef): AgentRunSummary {
  const model = String(row.model ?? "unknown");
  const type = catalogAgentType(model);
  const status = String(row.state);
  const running = status === "running";
  const live = running ? row.live ?? null : null;
  const endedAt = row.endedAt ? iso(row.endedAt) : null;
  const detail = row.detail === undefined ? null : String(row.detail);
  const runId = String(row.id);
  return {
    id: runKey(host.key, runId),
    host: host.key,
    hostLabel: host.label,
    hostName: host.name,
    runId,
    taskId: row.taskId,
    model,
    thinking: String(row.thinking ?? ""),
    provider: String(row.provider ?? ""),
    label: type.label,
    key: type.key,
    status,
    activity: normalizedActivity(status, live),
    activeTool: running && live?.activeTool ? String(live.activeTool) : null,
    startedAt: iso(row.startedAt),
    finishedAt: endedAt,
    observable: row.observable === true,
    error: status === "error" ? detail : null,
  };
}

// A tool card is rendered from named argument fields — a bash `command` and
// its `timeout`, a `path`, an edit count — so clients receive `args` as an
// object, exactly as thread events carry it. A transcript is appended by a
// separately deployed process, and one that JSON-encoded its arguments would
// otherwise render as a row of empty cards, so a quoted object is decoded here
// at the boundary rather than in every client.
function toolArgs(payload: Record<string, unknown>): Record<string, unknown> {
  if (typeof payload.args !== "string") return payload;
  try {
    const decoded = JSON.parse(payload.args);
    return decoded && typeof decoded === "object" && !Array.isArray(decoded)
      ? { ...payload, args: decoded }
      : payload;
  } catch { return payload; }
}

// A transcript grows in another process, so a reader keeps a byte cursor per
// run and parses only newly published bytes.
export class TranscriptBuffer {
  offset = 0;
  touchedAt = 0;
  private partial = "";
  private events: AgentRunEvent[] = [];

  reset(offset = 0) {
    this.offset = offset;
    this.partial = "";
    this.events = [];
  }

  append(text: string) {
    this.partial += text;
    const lines = this.partial.split("\n");
    this.partial = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        this.events.push({ seq: Number(entry.seq), time: String(entry.time), type: String(entry.type), ...toolArgs(entry.payload ?? {}) });
      } catch { /* A partially flushed line is simply skipped. */ }
    }
    if (this.events.length > MAX_BUFFERED_EVENTS) this.events = this.events.slice(-MAX_BUFFERED_EVENTS);
  }

  slice(after: number): AgentRunEvent[] {
    const visible = this.events.filter((entry) => entry.seq > after);
    return after === 0 ? visible.slice(-MAX_DELIVERED_EVENTS) : visible.slice(0, MAX_DELIVERED_EVENTS);
  }
}
