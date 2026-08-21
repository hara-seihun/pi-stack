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

interface CompletionReport {
  complete: boolean;
  productive?: boolean;
  summary: string;
  artifacts?: string[];
}

export class PiHost implements HostManager {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly transcripts = new Map<string, RunTranscript>();

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

  private async run(spec: LaunchSpec, transcript: RunTranscript | undefined): Promise<HostRunResult> {
    let report: CompletionReport | undefined;
    const taskComplete = {
      name: "task_complete",
      label: "Complete task",
      description:
        "Report this launch's validated result. Call it when your work is done; " +
        "calling it again replaces the earlier report. Set complete=true only when " +
        "the task's completion condition is satisfied. Set productive=false only " +
        "when this launch processed no work unit at all.",
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
        return { content: [{ type: "text" as const, text: "Report recorded." }], details: undefined };
      },
    };

    // A builtin family resolves before the session exists; an extension
    // provider (cursor) exists only inside the session's own model runtime,
    // because the extension that registers it is loaded per session.
    const preresolved = this.options.resolveModel(spec);
    const { session } = await createAgentSession({
      cwd: spec.cwd,
      agentDir: this.options.agentDir,
      // The SDK's Model type is provider-internal; the resolver returns one.
      model: preresolved as never,
      thinkingLevel: spec.thinking as never,
      customTools: [taskComplete],
    });
    this.sessions.set(spec.runId, session);
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
    transcript?.append("user", { text: spec.prompt });
    const heartbeat = setInterval(
      () => this.events.heartbeat(spec.runId, Date.now()),
      HEARTBEAT_MS,
    );
    try {
      await session.prompt(spec.prompt);
      // prompt() resolves even when the turn failed provider-side; the
      // truth is on the final assistant message. An errored turn must be an
      // error run (circuit breaker, account cooldown), never quiet
      // unproductive-done — that combination relaunches every tick.
      const last = [...session.messages]
        .reverse()
        .find((m): m is typeof m & { stopReason?: string; errorMessage?: string } => m.role === "assistant");
      if (report === undefined && last?.stopReason === "error") {
        return { state: "error", detail: last.errorMessage ?? "assistant turn errored" };
      }
      if (report === undefined && last?.stopReason === "aborted") {
        return { state: "aborted", detail: "session aborted" };
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
      session.dispose();
    }
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
            args: bounded(event.args),
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
