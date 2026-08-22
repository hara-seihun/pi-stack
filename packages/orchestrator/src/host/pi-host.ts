import { createAgentSession, type AgentSession } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { HostEvents, HostManager, HostRunResult, LaunchSpec } from "./types.js";
import { RunTranscript } from "./transcript.js";

/**
 * In-process host: each launch is one embedded pi AgentSession. This file is
 * a thin adapter over the pi SDK and holds no policy — capacity, custody,
 * and retry decisions all live upstream in broker and controller, so the
 * only logic here is session lifecycle and result plumbing.
 *
 * The task prompt is delivered as the session's first user message (the SDK
 * assembles the system prompt itself, so hosted sessions see exactly what an
 * interactive session would). Nothing here may mention tiers.
 */

const HEARTBEAT_MS = 30_000;
/** Ledger writes per session while it streams: liveness needs a coarse clock. */
const PROGRESS_WRITE_INTERVAL_MS = 15_000;

/**
 * How long a session may keep working before the host stops re-prompting it,
 * and how many consecutive turns may pass with nothing reported before the
 * host accepts that the lane is spent.
 */
export const SESSION_BUDGET_MS = 4 * 3_600_000;
const MAX_IDLE_TURNS = 2;

/**
 * What the host says to a session that stopped talking while its budget and
 * its lane still have room.
 *
 * A model ends its turn the moment it writes a summary, and a turn ending
 * used to end the run: standing research lanes whose prompts say "submitting
 * is a checkpoint, not an exit" were being torn down at the first checkpoint,
 * half an hour in, and the next launch started again from an empty context.
 * No wording in a task prompt can fix that, because the instruction is
 * addressed to an agent that no longer exists by the time it would apply.
 * A pointer, not a pep talk: the work is where the agent left it.
 */
const CONTINUE =
  "Your session is still live and this lane still has work. You are not finished. " +
  "Go back to the blocker you just named and take the next architecture on it, or " +
  "pick the next target in scope and attack that; re-read your own trail if you need " +
  "to recover where you were. Call task_complete again as a running report each time " +
  "you land something. If the lane genuinely has nothing left to work on, say so " +
  "plainly and stop.";

interface CompletionReport {
  complete: boolean;
  productive?: boolean;
  summary: string;
  artifacts?: string[];
}

export class PiHost implements HostManager {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly transcripts = new Map<string, RunTranscript>();
  /** Runs already reported terminal by `kill`, so the shift loop's own late
   * (or never-arriving) result cannot report a second outcome. */
  private readonly killed = new Set<string>();

  constructor(
    private readonly events: HostEvents,
    private readonly options: {
      /** pi agent dir (auth.json, models.json). Default: SDK default. */
      readonly agentDir?: string;
      /** Resolve a launch to a pi Model object. Alias accounts re-home the
       * family model onto the account's provider alias so credentials
       * resolve per account. Returning undefined defers to the session's own
       * model runtime, which is the only place extension-registered
       * providers (cursor) exist. */
      readonly resolveModel: (spec: LaunchSpec) => unknown;
      /** Directory root for per-run transcripts; omit to disable them. */
      readonly runsRoot?: string;
      /** How long one session may keep working. Default 4h. */
      readonly sessionBudgetMs?: number;
      /** Session factory. Defaults to the pi SDK; a test supplies its own to
       * exercise the shift loop without a provider. */
      readonly openSession?: typeof createAgentSession;
    },
  ) {}

  launch(spec: LaunchSpec): void {
    const transcript =
      this.options.runsRoot === undefined
        ? undefined
        : new RunTranscript(spec.runId, this.options.runsRoot);
    void this.run(spec, transcript)
      .catch((thrown: unknown): HostRunResult => ({ state: "error", detail: String(thrown) }))
      .then((result) => {
        if (this.killed.delete(spec.runId)) return;
        // The closing notice is the transcript's own terminal fact; the run
        // row remains the authority on outcome.
        transcript?.append("notice", {
          text: `Run ${result.state}${result.detail ? `: ${result.detail}` : ""}`,
        });
        transcript?.live({ activity: "IDLE" }, { force: true });
        this.events.runFinished(spec.runId, result, Date.now());
      });
  }

  abort(runId: string): void {
    void this.sessions.get(runId)?.abort();
  }

  kill(runId: string, detail: string): void {
    const session = this.sessions.get(runId);
    if (session === undefined) return;
    this.killed.add(runId);
    this.sessions.delete(runId);
    const transcript = this.transcripts.get(runId);
    this.transcripts.delete(runId);
    transcript?.append("notice", { text: `Run killed: ${detail}` });
    transcript?.live({ activity: "IDLE" }, { force: true });
    void session.abort();
    session.dispose();
    this.events.runFinished(runId, { state: "aborted", detail }, Date.now());
  }

  /**
   * Deliver an operator message into a live session as a user turn, and
   * mirror it into the transcript so the run's record shows why the agent
   * changed course. Steered, not queued as a follow-up: an operator
   * correcting a running agent means "from the next turn on", and a
   * follow-up would sit unread behind however many hours of tool calls the
   * agent has left — which is exactly the behaviour worth correcting.
   */
  message(runId: string, text: string): boolean {
    const session = this.sessions.get(runId);
    if (session === undefined) return false;
    this.transcripts.get(runId)?.append("user", { text });
    void session.sendUserMessage(text, { deliverAs: "steer" }).catch(() => {
      // A session that ended between the tick and delivery is not an error
      // worth killing a runner over; the run row already tells that story.
    });
    return true;
  }

  /** Whether a session for this run is still live in this process. */
  has(runId: string): boolean {
    return this.sessions.has(runId);
  }

  liveRuns(): readonly string[] {
    return [...this.sessions.keys()];
  }

  private async run(spec: LaunchSpec, transcript: RunTranscript | undefined): Promise<HostRunResult> {
    let report: CompletionReport | undefined;
    let reports = 0;
    const taskComplete = {
      name: "task_complete",
      label: "Complete task",
      description:
        "Running report of this launch's validated results. Call it with an updated " +
        "cumulative summary every time you land something, then keep working; each " +
        "call replaces the earlier report and the newest is the record. Set " +
        "complete=true only when the task's completion condition is satisfied. Set " +
        "productive=false only when this launch processed no work unit at all.",
      parameters: Type.Object({
        complete: Type.Boolean(),
        productive: Type.Optional(
          Type.Boolean({ description: "Whether this launch processed a real work unit. Defaults to true." }),
        ),
        summary: Type.String({ minLength: 1 }),
        artifacts: Type.Optional(Type.Array(Type.String())),
      }),
      execute: async (_id: string, params: CompletionReport) => {
        report = params;
        reports++;
        return { content: [{ type: "text" as const, text: "Report recorded." }], details: undefined };
      },
    };

    // A builtin family resolves before the session exists; an extension
    // provider (cursor) exists only inside the session's own model runtime,
    // because the extension that registers it is loaded per session.
    const preresolved = this.options.resolveModel(spec);
    const { session } = await (this.options.openSession ?? createAgentSession)({
      cwd: spec.cwd,
      agentDir: this.options.agentDir,
      // The SDK's Model type is provider-internal; the resolver returns one.
      model: preresolved as never,
      thinkingLevel: spec.thinking as never,
      customTools: [taskComplete],
    });
    this.sessions.set(spec.runId, session);
    // Extensions only come alive when a mode binds them: `bindExtensions` is
    // what emits `session_start`, and everything an extension sets up in
    // response — MCP server connections above all — simply never happens in a
    // session that skips it. Hosted sessions had the `mcp` tool on their
    // surface (it registers at load time) answering "MCP not initialized" to
    // every call, so fleet agents told to use the math ledger's MCP server
    // spent their turns writing curl JSON-RPC helpers instead. A headless
    // host binds print mode: no UI, no command actions, and extension errors
    // go to the run's own log.
    await session.bindExtensions({
      mode: "print",
      onError: (err: { extensionPath: string; error: unknown }) => {
        transcript?.append("notice", {
          text: `Extension error (${err.extensionPath}): ${String(err.error)}`,
        });
      },
    } as never);
    this.events.sessionStarted(spec.runId, session.sessionManager.getSessionId());
    if (preresolved === undefined) {
      const model = session.modelRuntime.getModel(spec.provider, spec.model);
      if (model === undefined) {
        session.dispose();
        this.sessions.delete(spec.runId);
        return { state: "error", detail: `unknown model ${spec.provider}/${spec.model}` };
      }
      // Extension providers own their transport; re-homing the model onto an
      // alias id would strip it and leak the request to the family's public
      // API. Such an account is a configuration error, not a runtime fallback.
      if (spec.accountId !== spec.provider) {
        session.dispose();
        this.sessions.delete(spec.runId);
        return {
          state: "error",
          detail: `account ${spec.accountId} cannot alias extension provider ${spec.provider}`,
        };
      }
      await session.setModel(model);
      if (spec.thinking !== undefined) session.setThinkingLevel(spec.thinking as never);
    }
    // Registered only past the model-resolution returns above: a session
    // that never runs must not be addressable by an operator message.
    if (transcript !== undefined) this.transcripts.set(spec.runId, transcript);
    const unsubscribe = transcript === undefined ? undefined : this.publish(transcript, session);
    const stopProgress = this.trackProgress(spec.runId, session);
    transcript?.append("user", { text: spec.prompt });
    const heartbeat = setInterval(
      () => this.events.heartbeat(spec.runId, Date.now()),
      HEARTBEAT_MS,
    );
    const deadline = Date.now() + (this.options.sessionBudgetMs ?? SESSION_BUDGET_MS);
    try {
      // A launch is a shift, not a single turn. The host keeps prompting the
      // same session — same context, same working directory, same trail —
      // until the session's budget runs out, the turn fails, an operator
      // aborts, or the agent has twice had nothing to report. Ending at the
      // first quiet turn threw away a warm context that had just paid for
      // itself and made every lane restart from scratch.
      let idle = 0;
      for (let turn = 0; ; turn++) {
        const before = reports;
        if (turn > 0) transcript?.append("user", { text: CONTINUE });
        await session.prompt(turn === 0 ? spec.prompt : CONTINUE);
        // prompt() resolves even when the turn failed provider-side; the
        // truth is on the final assistant message. An errored turn must be an
        // error run (circuit breaker, account cooldown), never quiet
        // unproductive-done — that combination relaunches every tick.
        const last = [...session.messages]
          .reverse()
          .find(
            (m): m is typeof m & { stopReason?: string; errorMessage?: string } =>
              m.role === "assistant",
          );
        if (last?.stopReason === "error") {
          if (report === undefined) {
            return { state: "error", detail: last.errorMessage ?? "assistant turn errored" };
          }
          break; // Work already banked: report it rather than lose it.
        }
        if (last?.stopReason === "aborted") {
          if (report === undefined) return { state: "aborted", detail: "session aborted" };
          break;
        }
        idle = reports > before ? 0 : idle + 1;
        if (idle >= MAX_IDLE_TURNS || Date.now() >= deadline) break;
        // A queue lane can empty its queue mid-shift, and CONTINUE would then
        // assert work that no longer exists. Ending the shift is the honest
        // answer; the runner decides which lanes work that way.
        if (this.events.laneDrained(spec.taskId)) {
          transcript?.append("notice", { text: "Lane drained: no work left, ending the shift." });
          break;
        }
      }
      if (report === undefined) {
        return { state: "done", productive: false, detail: "no task_complete report" };
      }
      return {
        state: "done",
        productive: report.productive ?? true,
        complete: report.complete,
        detail: report.summary,
      };
    } finally {
      clearInterval(heartbeat);
      this.sessions.delete(spec.runId);
      this.transcripts.delete(spec.runId);
      unsubscribe?.();
      stopProgress();
      session.dispose();
    }
  }

  /**
   * Records that the session is doing something. Every event counts, including
   * token deltas, because the question this answers is whether the provider is
   * still feeding the run at all — not whether the agent is being useful. Writes
   * are throttled: a streaming turn produces thousands of events and the ledger
   * only needs to know the session was alive within the stall window.
   */
  private trackProgress(runId: string, session: AgentSession): () => void {
    let lastWrite = Date.now();
    this.events.progress(runId, lastWrite);
    return session.subscribe(() => {
      const now = Date.now();
      if (now - lastWrite < PROGRESS_WRITE_INTERVAL_MS) return;
      lastWrite = now;
      this.events.progress(runId, now);
    });
  }

  /**
   * Mirrors the session onto its transcript. Settled events are appended
   * unconditionally (they are the record of the run); the in-flight turn is
   * published only while an observer's watch marker is fresh.
   */
  private publish(transcript: RunTranscript, session: AgentSession): () => void {
    let liveText = "";
    let liveThinking = "";
    const live = (force = false) => transcript.live({ liveText, liveThinking }, { force });
    return session.subscribe((event: any) => {
      switch (event.type) {
        case "message_update": {
          const update = event.assistantMessageEvent;
          if (update?.type === "text_delta") liveText += update.delta ?? "";
          else if (update?.type === "thinking_start") liveThinking = "";
          else if (update?.type === "thinking_delta") liveThinking += update.delta ?? "";
          else if (update?.type === "thinking_end") {
            const text = liveThinking || String(update.content ?? "");
            if (text) transcript.append("thinking", { text });
            liveThinking = "";
          } else return;
          live();
          return;
        }
        case "message_end": {
          const text = messageText(event.message);
          if (text) transcript.append("assistant", { text });
          if (liveThinking) transcript.append("thinking", { text: liveThinking });
          liveText = "";
          liveThinking = "";
          live(true);
          return;
        }
        case "tool_execution_start":
          transcript.append("tool_start", {
            toolCallId: String(event.toolCallId ?? ""),
            name: String(event.toolName ?? "tool"),
            args: boundedArgs(event.args),
          });
          return;
        case "tool_execution_end":
          transcript.append("tool_end", {
            toolCallId: String(event.toolCallId ?? ""),
            name: String(event.toolName ?? "tool"),
            output: bounded(toolOutput(event.result)),
            error: Boolean(event.isError),
          });
          return;
        case "auto_retry_start":
          transcript.append("notice", { text: `Retrying: ${String(event.errorMessage ?? "provider error")}` });
          return;
        case "auto_retry_end":
          if (!event.success) {
            transcript.append("notice", { text: `Retry failed: ${String(event.finalError ?? "provider error")}` });
          }
          return;
        case "compaction_start":
          transcript.append("notice", { text: "Compacting context…" });
          return;
        case "compaction_end":
          transcript.append("notice", {
            text: event.result ? "Context compacted" : "Context compaction failed",
          });
          return;
        default:
          return;
      }
    });
  }
}

/** Transcript payloads are for a human reader, not a second data authority:
 * an enormous tool argument or result is truncated rather than mirrored. */
const MAX_PAYLOAD = 8_000;

function bounded(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "") ?? "";
  return text.length > MAX_PAYLOAD ? `${text.slice(0, MAX_PAYLOAD)}… [truncated]` : text;
}

/** Tool arguments stay structured. A reader renders a tool card from named
 * fields — a bash `command` and its `timeout`, a `path`, an edit count — so
 * flattening them to a JSON blob would leave every card in the observer's
 * transcript blank. Oversized arguments degrade to a labelled preview rather
 * than to a second serialization of the same object. */
function boundedArgs(value: unknown): unknown {
  let encoded: string;
  try {
    encoded = JSON.stringify(value ?? {}) ?? "{}";
  } catch {
    return { unavailable: true };
  }
  if (encoded.length <= MAX_PAYLOAD) return value ?? {};
  return { truncated: true, preview: `${encoded.slice(0, MAX_PAYLOAD)}… [truncated]` };
}

function messageText(message: any): string {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content
    .filter((part: any) => part?.type === "text")
    .map((part: any) => String(part.text ?? ""))
    .join("")
    .trim();
}

function toolOutput(result: any): string {
  if (result === undefined || result === null) return "";
  if (typeof result === "string") return result;
  if (Array.isArray(result.content)) {
    return result.content
      .filter((part: any) => part?.type === "text")
      .map((part: any) => String(part.text ?? ""))
      .join("\n")
      .trim();
  }
  return JSON.stringify(result);
}
