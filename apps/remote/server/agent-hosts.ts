import type { OrchestratorObserver } from "pi-orchestrator/api";
import {
  summarizeAgentRun,
  TranscriptBuffer,
  type AgentHostRef,
  type AgentRunEvent,
  type AgentRunSummary,
} from "./agent-runs";
export interface AgentHostSnapshot {
  runs: AgentRunSummary[];
  running: number;
  models: Array<{ model: string; count: number }>;
  updatedAt: string | null;
  error: string | null;
}

export interface AgentHostOptions {
  key: string;
  label: string;
  name: string;
  runningLimit?: number;
  maxTailBytes?: number;
  maxWatchedRuns?: number;
}

const DEFAULT_TAIL_BYTES = 256 * 1024;

/** Presentation and caching around the orchestrator's public observation API.
 * Ledger schema and transcript file mechanics stay on the owning side of that
 * boundary. */
export class AgentHost {
  readonly ref: AgentHostRef;
  private readonly buffers = new Map<string, TranscriptBuffer>();
  private snapshot: AgentHostSnapshot = { runs: [], running: 0, models: [], updatedAt: null, error: null };
  private inflight: Promise<void> | null = null;

  constructor(private readonly orchestrator: OrchestratorObserver, private readonly options: AgentHostOptions) {
    this.ref = { key: options.key, label: options.label, name: options.name };
  }

  get key(): string { return this.options.key; }

  cached(): AgentHostSnapshot { return this.snapshot; }

  refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      const at = Date.now();
      try {
        const listing = await this.orchestrator.listRuns(this.options.runningLimit ?? 400);
        this.snapshot = {
          runs: listing.runs.map((row) => summarizeAgentRun(row, this.ref)),
          running: listing.running,
          models: [...listing.models],
          updatedAt: new Date(at).toISOString(),
          error: null,
        };
      } catch (cause: any) {
        this.snapshot = { ...this.snapshot, error: cause?.message ?? `${this.options.name} agents unavailable` };
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  async events(runId: string, after: number, { watch = true } = {}): Promise<{
    run: AgentRunSummary | null;
    events: AgentRunEvent[];
    liveText: string;
    liveThinking: string;
  }> {
    const buffer = this.buffer(runId);
    const tail = await this.orchestrator.tailRun(
      runId,
      buffer.touchedAt ? buffer.offset : -1,
      this.options.maxTailBytes ?? DEFAULT_TAIL_BYTES,
      watch,
    );
    buffer.touchedAt = Date.now();
    if (tail.offset !== buffer.offset) buffer.reset(tail.offset);
    buffer.offset = tail.next;
    if (tail.chunk) buffer.append(tail.chunk);
    const run = tail.run ? summarizeAgentRun(tail.run, this.ref) : null;
    const live = run?.status === "running" ? tail.run?.live ?? null : null;
    return {
      run,
      events: buffer.slice(after),
      liveText: String(live?.liveText ?? ""),
      liveThinking: String(live?.liveThinking ?? ""),
    };
  }

  close(): void { this.orchestrator.close(); }

  private buffer(runId: string): TranscriptBuffer {
    let buffer = this.buffers.get(runId);
    if (!buffer) {
      buffer = new TranscriptBuffer();
      this.buffers.set(runId, buffer);
      const limit = this.options.maxWatchedRuns ?? 12;
      while (this.buffers.size > limit) {
        const oldest = [...this.buffers.entries()]
          .sort((left, right) => left[1].touchedAt - right[1].touchedAt)[0];
        if (!oldest || oldest[0] === runId) break;
        this.buffers.delete(oldest[0]);
      }
    }
    return buffer;
  }
}
