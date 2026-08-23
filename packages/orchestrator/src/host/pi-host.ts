import {
  convertToLlm,
  createAgentSession,
  DefaultResourceLoader,
  serializeConversation,
  SettingsManager,
  type AgentSession,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { HostEvents, HostManager, HostRunResult, LaunchSpec } from "./types.js";
import {
  continuationFor,
  describeWait,
  interruptedTurnPrompt,
  ShiftObserver,
} from "./continuations.js";
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
 * In-turn retry, which is the first and best line: pi replays the interrupted
 * turn on the same context with nothing injected and no message duplicated, so
 * an outage the provider clears inside five minutes costs the agent nothing at
 * all and it never learns one happened. The default budget is three attempts
 * over fourteen seconds, which is shorter than most throttles last. Waiting
 * this long only ever delays the report of an error that was going to be
 * reported anyway.
 */
const SESSION_RETRY = { enabled: true, maxRetries: 6, baseDelayMs: 5_000 } as const;

/** Waits are slept in slices so the run keeps reporting progress: a session
 * waiting out a provider is not the stalled session the runner reaps, and
 * only a signal on the same clock can tell those apart. */
const WAIT_SLICE_MS = 20_000;


interface CompletionReport {
  complete: boolean;
  productive?: boolean;
  summary: string;
  artifacts?: string[];
}

export class PiHost implements HostManager {
  private readonly runtimes = new Map<
    string,
    {
      readonly session: AgentSession;
      readonly cancel: () => void;
      readonly cleanup: () => void;
    }
  >();
  private readonly transcripts = new Map<string, RunTranscript>();
  /** Runs already reported terminal by `kill`, so the shift loop's own late
   * result cannot report a second outcome. */
  private readonly killed = new Set<string>();
  /** Runs an operator or the runner has asked to stop. A session waiting out
   * a provider outage is not inside `prompt()`, so `session.abort()` has
   * nothing to interrupt; the wait watches this instead. */
  private readonly aborting = new Set<string>();

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
      /** Session factory. Defaults to the pi SDK; a test supplies its own to
       * exercise the shift loop without a provider. */
      readonly openSession?: typeof createAgentSession;
      /** Doctrine fetcher. Defaults to HTTP fetch; a test supplies its own. */
      readonly fetchDoctrine?: (url: string) => Promise<string>;
      /** Opening-probe runner. Defaults to `bash -c` in the launch cwd; a
       * test supplies its own. */
      readonly runOpeningProbe?: (command: string, cwd: string) => Promise<string>;
    },
  ) {}

  /** Last good copy of each doctrine document, so a transient fetch failure
   * mid-week does not strip doctrine from launches. A URL that has never
   * been fetched successfully fails the launch instead: a frontier session
   * without its binding anti-ladder doctrine is exactly the run the night of
   * 2026-08-21 taught us not to start. */
  private readonly doctrines = new Map<string, { content: string; fetchedAt: number }>();
  private static readonly DOCTRINE_TTL_MS = 15 * 60_000;

  private async doctrine(url: string): Promise<string> {
    const cached = this.doctrines.get(url);
    if (cached !== undefined && Date.now() - cached.fetchedAt < PiHost.DOCTRINE_TTL_MS) {
      return cached.content;
    }
    try {
      const fetcher =
        this.options.fetchDoctrine ??
        (async (target: string): Promise<string> => {
          const response = await fetch(target);
          if (!response.ok) throw new Error(`${target}: HTTP ${response.status}`);
          return response.text();
        });
      const content = await fetcher(url);
      this.doctrines.set(url, { content, fetchedAt: Date.now() });
      return content;
    } catch (thrown) {
      if (cached !== undefined) return cached.content;
      throw new Error(`doctrine unavailable: ${String(thrown)}`);
    }
  }

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
    this.aborting.add(runId);
    void this.runtimes.get(runId)?.session.abort();
  }

  kill(runId: string, detail: string): void {
    const runtime = this.runtimes.get(runId);
    if (runtime === undefined) return;
    this.killed.add(runId);
    const transcript = this.transcripts.get(runId);
    transcript?.append("notice", { text: `Run killed: ${detail}` });
    transcript?.live({ activity: "IDLE" }, { force: true });
    void runtime.session.abort();
    runtime.cancel();
    runtime.cleanup();
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
    const session = this.runtimes.get(runId)?.session;
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
    return this.runtimes.has(runId);
  }

  liveRuns(): readonly string[] {
    return [...this.runtimes.keys()];
  }

  private async run(spec: LaunchSpec, transcript: RunTranscript | undefined): Promise<HostRunResult> {
    // The opening exchange may be a template: a probe command sampling, say,
    // a different famous open problem for every launch. Resolved before the
    // session exists, and never sent unresolved — an agent handed literal
    // `{{placeholders}}` would rightly disbelieve the whole exchange, so a
    // probe failure fails the launch instead.
    let opening = spec.opening ?? [];
    let prompt = spec.prompt;
    if (spec.openingProbe !== undefined) {
      try {
        const probe = this.options.runOpeningProbe ?? execOpeningProbe;
        const values = parseProbeValues(await probe(spec.openingProbe, spec.cwd ?? process.cwd()));
        opening = opening.map((message) => renderTemplate(message, values));
        if (prompt !== undefined) prompt = renderTemplate(prompt, values);
      } catch (thrown) {
        return { state: "error", detail: `opening probe failed: ${String(thrown)}` };
      }
    }
    let report: CompletionReport | undefined;
    let reports = 0;
    // Check-ins are generated from what the shift actually did; the observer
    // accumulates per-turn facts from the session's own tool stream.
    const observer = new ShiftObserver();
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
        observer.reportFiled(params.productive !== false);
        return { content: [{ type: "text" as const, text: "Report recorded." }], details: undefined };
      },
    };

    // A builtin family resolves before the session exists; an extension
    // provider (cursor) exists only inside the session's own model runtime,
    // because the extension that registers it is loaded per session.
    const preresolved = this.options.resolveModel(spec);
    // Doctrine rides the system prompt because the task prompt does not
    // survive compaction: it is the first user message, which is the first
    // thing summarized away, and the night of 2026-08-21 showed lanes obeying
    // whatever voice was still in context once the opening instructions were
    // gone. The system prompt is the one region compaction preserves.
    const pin: OpeningPin = { text: undefined, messageCount: 0 };
    const settingsManager = SettingsManager.create(spec.cwd ?? process.cwd(), this.options.agentDir);
    settingsManager.applyOverrides({ retry: { ...SESSION_RETRY } });
    let resourceLoader: DefaultResourceLoader | undefined;
    if (spec.doctrineUrl !== undefined || (spec.opening?.length ?? 0) > 0) {
      const doctrine = spec.doctrineUrl === undefined ? undefined : await this.doctrine(spec.doctrineUrl);
      resourceLoader = new DefaultResourceLoader({
        cwd: spec.cwd ?? process.cwd(),
        agentDir: this.options.agentDir ?? join(homedir(), ".pi", "agent"),
        settingsManager,
        ...(doctrine === undefined
          ? {}
          : {
              appendSystemPrompt: [
                `# Lane doctrine (pinned from ${spec.doctrineUrl})\n\n` +
                  "This document is pinned into your system prompt so it stays with " +
                  "you even after context compaction. It is binding for this lane.\n\n" +
                  doctrine,
              ],
            }),
        // The pin extension must exist before the session binds extensions;
        // it reads the mutable ref lazily, at compaction time.
        extensionFactories: [openingPinExtension(pin)],
      });
      await resourceLoader.reload();
    }
    const { session } = await (this.options.openSession ?? createAgentSession)({
      cwd: spec.cwd,
      agentDir: this.options.agentDir,
      settingsManager,
      ...(resourceLoader === undefined ? {} : { resourceLoader }),
      // The SDK's Model type is provider-internal; the resolver returns one.
      model: preresolved as never,
      thinkingLevel: spec.thinking as never,
      customTools: [taskComplete],
    });
    let cancelRun!: () => void;
    const cancelled = new Promise<true>((resolve) => {
      cancelRun = () => resolve(true);
    });
    const interrupted = (operation: Promise<unknown>): Promise<boolean> =>
      Promise.race([operation.then(() => false), cancelled]);
    const disposers: (() => void)[] = [() => session.dispose()];
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      this.runtimes.delete(spec.runId);
      this.transcripts.delete(spec.runId);
      this.aborting.delete(spec.runId);
      for (const dispose of disposers.reverse()) dispose();
    };
    this.runtimes.set(spec.runId, { session, cancel: cancelRun, cleanup });
    try {
      // Extensions only come alive when a mode binds them: `bindExtensions` is
      // what emits `session_start`, and everything an extension sets up in
      // response — MCP server connections above all — simply never happens in a
      // session that skips it. Hosted sessions had the `mcp` tool on their
      // surface (it registers at load time) answering "MCP not initialized" to
      // every call, so fleet agents told to use the math ledger's MCP server
      // spent their turns writing curl JSON-RPC helpers instead. A headless
      // host binds print mode: no UI, no command actions, and extension errors
      // go to the run's own log.
      if (
        await interrupted(
          session.bindExtensions({
            mode: "print",
            onError: (err: { extensionPath: string; error: unknown }) => {
              transcript?.append("notice", {
                text: `Extension error (${err.extensionPath}): ${String(err.error)}`,
              });
            },
          } as never),
        )
      ) {
        return { state: "aborted", detail: "session killed" };
      }
      this.events.sessionStarted(spec.runId, session.sessionManager.getSessionId());
      if (preresolved === undefined) {
        const model = session.modelRuntime.getModel(spec.provider, spec.model);
        if (model === undefined) {
          return { state: "error", detail: `unknown model ${spec.provider}/${spec.model}` };
        }
        // Extension providers own their transport; re-homing the model onto an
        // alias id would strip it and leak the request to the family's public
        // API. Such an account is a configuration error, not a runtime fallback.
        if (spec.accountId !== spec.provider) {
          return {
            state: "error",
            detail: `account ${spec.accountId} cannot alias extension provider ${spec.provider}`,
          };
        }
        if (await interrupted(session.setModel(model))) {
          return { state: "aborted", detail: "session killed" };
        }
        if (spec.thinking !== undefined) session.setThinkingLevel(spec.thinking as never);
      }
      // Live transcript publication starts only after model resolution, so a
      // rejected model setup is never presented as an active run.
      if (transcript !== undefined) this.transcripts.set(spec.runId, transcript);
      const unsubscribe = transcript === undefined ? undefined : this.publish(transcript, session);
      if (unsubscribe !== undefined) disposers.push(unsubscribe);
      disposers.push(
        session.subscribe((event: any) => {
          if (event.type === "tool_execution_start") {
            observer.toolCall(String(event.toolName ?? "tool"), event.args);
          }
        }),
      );
      const stopProgress = this.trackProgress(spec.runId, session);
      disposers.push(stopProgress);
      const heartbeat = setInterval(
        () => this.events.heartbeat(spec.runId, Date.now()),
        HEARTBEAT_MS,
      );
      disposers.push(() => clearInterval(heartbeat));
      // A launch is a shift, not a single turn. The host keeps prompting the
      // same session — same context, same working directory, same trail —
      // until it has spent its check-ins, the turn fails, an operator aborts,
      // or the agent has twice had nothing to report. Ending at the first
      // quiet turn threw away a warm context that had just paid for itself
      // and made every lane restart from scratch. Nothing here is timed: a
      // turn may run as long as the agent keeps working.
      // The opening exchange is lived, not injected: each message is a real
      // turn the agent answers with whatever tools it reaches for, and the
      // record of that lived exchange is what the pin extension replays
      // verbatim through every compaction. Injecting a transcript the agent
      // never produced would be spotted — agents are acutely good at telling
      // self from not-self — and disbelieved.
      // A shift survives its provider. Everything below treats a failed turn
      // as weather to wait out rather than as the end of the session: the
      // runner prices the wait (see HostEvents.turnFailed), the host sleeps it
      // while still reporting progress, and the same context picks up where it
      // stopped. Only when the runner says there is nothing left to wait for
      // does the run end.
      let stalls = 0;
      for (const message of opening) {
        for (;;) {
          transcript?.append("user", { text: message });
          if (await interrupted(session.prompt(message))) {
            return { state: "aborted", detail: "session killed" };
          }
          const opener = lastAssistant(session);
          if (opener?.stopReason === "error") {
            const detail = opener.errorMessage ?? "opening turn errored";
            const waited = await this.recover(spec, transcript, detail, stalls + 1, interrupted);
            if (waited === "killed") return { state: "aborted", detail: "session killed" };
            // The opening is a lived exchange, so the message is asked again
            // rather than resumed: an opening turn nobody answered is not an
            // opening the pin can replay.
            if (typeof waited === "number") {
              stalls++;
              continue;
            }
            return { state: "error", detail };
          }
          if (opener?.stopReason === "aborted") {
            return { state: "aborted", detail: "session aborted" };
          }
          stalls = 0;
          observer.endTurn();
          break;
        }
      }
      if (opening.length > 0) {
        pin.messageCount = session.messages.length;
        pin.text = serializeOpening(session.messages);
      }
      let turn = 0;
      let resume: string | undefined;
      for (;;) {
        // The lane's check-in (see continuations.ts) is generated from the
        // observed shift, so the message answers what the agent actually did
        // rather than firing a fixed sequence on a timer. A resumption note
        // pre-empts it: a turn the provider cut off was not a turn the agent
        // finished, and asking it "what did you land?" would be a lie about
        // what just happened.
        const message =
          resume ??
          (turn === 0
            ? prompt
            : continuationFor({
                taskId: spec.taskId,
                turn,
                turns: observer.turns(),
              }));
        transcript?.append("user", { text: message });
        if (await interrupted(session.prompt(message))) {
          return { state: "aborted", detail: "session killed" };
        }
        // prompt() resolves even when the turn failed provider-side; the
        // truth is on the final assistant message. An errored turn that is
        // out of waits must be an error run (circuit breaker, account
        // cooldown), never quiet unproductive-done — that combination
        // relaunches every tick.
        const last = lastAssistant(session);
        if (last?.stopReason === "error") {
          const detail = last.errorMessage ?? "assistant turn errored";
          const waited = await this.recover(spec, transcript, detail, stalls + 1, interrupted);
          if (waited === "killed") return { state: "aborted", detail: "session killed" };
          if (typeof waited === "number") {
            stalls++;
            resume = interruptedTurnPrompt(
              detail,
              `I waited ${describeWait(waited)} for the provider to come back, and it is ` +
                "answering again.",
            );
            continue;
          }
          if (report === undefined) return { state: "error", detail };
          break; // Work already banked: report it rather than lose it.
        }
        if (last?.stopReason === "aborted") {
          if (report === undefined) return { state: "aborted", detail: "session aborted" };
          break;
        }
        stalls = 0;
        resume = undefined;
        observer.endTurn();
        // A self-paced shift is one work turn: the agent ending it is the
        // agent deciding to stop, and no check-in second-guesses that.
        if (spec.selfPaced === true) break;
        // A queue lane can empty its queue mid-shift, and a continuation
        // would then assert work that no longer exists. Ending the shift is
        // the honest answer; the runner decides which lanes work that way.
        if (this.events.laneDrained(spec.taskId)) {
          transcript?.append("notice", { text: "Lane drained: no work left, ending the shift." });
          break;
        }
        // Spent in the ledger before it is spoken, so the budget survives
        // this process. Nothing about the turn's quality is consulted: the
        // host may ask five times, and how the agent spends the answers is
        // the agent's business.
        if (!this.events.claimCheckIn(spec.runId)) break;
        turn++;
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
      cleanup();
    }
  }

  /**
   * Waits out a failed turn, or reports that there is nothing to wait for.
   * Returns the milliseconds slept, `"give-up"` when the run should end, or
   * `"killed"` when the wait was interrupted.
   */
  private async recover(
    spec: LaunchSpec,
    transcript: RunTranscript | undefined,
    detail: string,
    attempt: number,
    interrupted: (operation: Promise<unknown>) => Promise<boolean>,
  ): Promise<number | "give-up" | "killed"> {
    const waitMs = this.events.turnFailed(spec.runId, detail, attempt);
    if (waitMs === undefined) return "give-up";
    transcript?.append("notice", {
      text: `Provider failed the turn (attempt ${attempt}); waiting ${describeWait(waitMs)} and ` +
        `continuing this session rather than ending it: ${detail}`,
    });
    const until = Date.now() + waitMs;
    for (let left = waitMs; left > 0; left = until - Date.now()) {
      if (await interrupted(sleep(Math.min(left, WAIT_SLICE_MS)))) return "killed";
      if (this.aborting.has(spec.runId)) return "killed";
      this.events.progress(spec.runId, Date.now());
    }
    return waitMs;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lastAssistant(
  session: AgentSession,
): { stopReason?: string; errorMessage?: string } | undefined {
  return [...session.messages]
    .reverse()
    .find(
      (m): m is typeof m & { stopReason?: string; errorMessage?: string } => m.role === "assistant",
    );
}

/** Mutable ref shared between the host's shift loop and the pin extension:
 * the loop fills it in when the opening exchange completes, the extension
 * reads it at each compaction. */
export interface OpeningPin {
  text: string | undefined;
  /** How many session messages the opening spans, so the first compaction
   * can exclude them from the generated work summary (they are already in
   * the pin, verbatim). */
  messageCount: number;
}

const PIN_DIVIDER = "# Work since the opening exchange";

/**
 * Keeps the session's opening exchange intact across both context
 * mechanisms.
 *
 * Context-guard (the global 250k-cap extension, loaded into hosted sessions
 * from the machine's settings packages) is the mechanism that actually
 * governs large-window models: it cuts the per-request view before pi's
 * native compaction ever triggers, and its cut evicts old tool-result
 * bodies — the opening's MCP traffic first of all. The pin registers the
 * opening's message count under the session id in
 * `globalThis.__piContextGuardProtect`; the guard treats that span as a
 * protected head that crosses every cut byte-identical.
 *
 * Pi's native compaction still governs where the guard does not reach —
 * models whose window sits below the guard's trigger, and cursor sessions,
 * which the guard excludes. There the `session_before_compact` handler
 * rebuilds the summary as the verbatim opening exchange followed by a
 * generated summary of the work after it. Either way the exchange is
 * replayed word for word — the agent said these things in this session,
 * and it stays able to recognize them as its own.
 *
 * On any failure the compaction handler steps aside and default compaction
 * runs: a session that loses its pin is degraded, a session that cannot
 * compact at all is dead.
 */
export function openingPinExtension(pin: OpeningPin): InlineExtension {
  return {
    name: "opening-pin",
    factory: (pi: any) => {
      const registry: Map<string, number> = ((globalThis as any).__piContextGuardProtect ??=
        new Map());
      let sessionId: string | undefined;
      const register = (ctx: any) => {
        const id = ctx?.sessionManager?.getSessionId?.();
        if (id === undefined) return;
        sessionId = id;
        // messageCount is 0 until the host's opening turns complete; register
        // on every event so the count lands as soon as it exists. Cuts happen
        // hundreds of events later.
        if (pin.messageCount > 0) registry.set(id, pin.messageCount);
      };
      pi.on("session_start", (_event: any, ctx: any) => register(ctx));
      pi.on("context", (_event: any, ctx: any) => {
        register(ctx);
        return undefined;
      });
      pi.on("session_shutdown", () => {
        if (sessionId !== undefined) registry.delete(sessionId);
      });
      pi.on("session_before_compact", async (event: any, ctx: any) => {
        if (pin.text === undefined) return undefined;
        try {
          const { preparation } = event;
          const all = [
            ...(preparation.messagesToSummarize ?? []),
            ...(preparation.turnPrefixMessages ?? []),
          ];
          // The first compaction still holds the opening as live messages;
          // they are dropped from the work summary because the pin already
          // carries them verbatim. Later compactions start past them.
          const isFirst = preparation.previousSummary === undefined;
          const work = isFirst ? all.slice(pin.messageCount) : all;
          const previousWork = preparation.previousSummary?.split(PIN_DIVIDER).pop()?.trim();
          let workSummary = previousWork ?? "";
          if (work.length > 0 && ctx.model !== undefined) {
            const conversation = serializeConversation(convertToLlm(work as never));
            const response = await ctx.modelRegistry.complete(
              ctx.model,
              {
                messages: [
                  {
                    role: "user",
                    content: [
                      {
                        type: "text",
                        text:
                          "Summarize this working session so it can continue after " +
                          "context compaction. Capture goals, key decisions and their " +
                          "rationale, validated results, current state, blockers, and " +
                          "next steps, as structured markdown. Be thorough but concise; " +
                          "the summary replaces the messages." +
                          (previousWork ? `\n\nEarlier summary to fold in:\n${previousWork}` : "") +
                          `\n\n<conversation>\n${conversation}\n</conversation>`,
                      },
                    ],
                    timestamp: Date.now(),
                  },
                ],
              },
              { maxTokens: 8192, signal: event.signal, cacheRetention: "none", sessionId: randomUUID() },
            );
            const text = (response.content ?? [])
              .filter((c: any) => c?.type === "text")
              .map((c: any) => String(c.text ?? ""))
              .join("\n")
              .trim();
            if (text === "") return undefined;
            workSummary = text;
            return {
              compaction: {
                summary: `${pin.text}\n\n${PIN_DIVIDER}\n\n${workSummary}`,
                firstKeptEntryId: preparation.firstKeptEntryId,
                tokensBefore: preparation.tokensBefore,
                usage: response.usage,
              },
            };
          }
          return {
            compaction: {
              summary: `${pin.text}\n\n${PIN_DIVIDER}\n\n${workSummary}`,
              firstKeptEntryId: preparation.firstKeptEntryId,
              tokensBefore: preparation.tokensBefore,
            },
          };
        } catch {
          return undefined;
        }
      });
    },
  };
}

/** One tool result inside the pinned opening may be large (an MCP `get` runs
 * to a few KB) but must stay whole enough to be the thing the agent actually
 * read; this cap only guards against a pathological giant result. */
const PIN_TOOL_RESULT_MAX = 16_000;

/**
 * Verbatim serialization of the opening exchange, in the same voice pi uses
 * when it serializes conversations ([User]/[Assistant]/[Tool result]), with
 * tool results kept essentially whole rather than truncated to a stub.
 */
export function serializeOpening(messages: readonly any[]): string {
  const parts: string[] = [
    "# This session's opening exchange, preserved verbatim",
    "The messages below are the word-for-word opening of this session — the " +
      "operator's messages, your replies, and the tool calls you made. They " +
      "are pinned so compaction never erases them.",
  ];
  for (const m of messages) {
    if (m?.role === "user") {
      const text = contentText(m);
      if (text) parts.push(`[User]:\n${text}`);
    } else if (m?.role === "assistant") {
      const text = contentText(m);
      if (text) parts.push(`[Assistant]:\n${text}`);
      const calls = (Array.isArray(m.content) ? m.content : [])
        .filter((c: any) => c?.type === "toolCall")
        .map((c: any) => `${String(c.name ?? "tool")}(${safeJson(c.arguments ?? c.args)})`);
      if (calls.length > 0) parts.push(`[Assistant tool calls]: ${calls.join("; ")}`);
    } else if (m?.role === "toolResult") {
      const text = contentText(m);
      parts.push(
        `[Tool result]: ${
          text.length > PIN_TOOL_RESULT_MAX
            ? `${text.slice(0, PIN_TOOL_RESULT_MAX)}… [truncated]`
            : text
        }`,
      );
    }
  }
  return parts.join("\n\n");
}

function contentText(message: any): string {
  if (typeof message.content === "string") return message.content.trim();
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part: any) => part?.type === "text")
    .map((part: any) => String(part.text ?? ""))
    .join("")
    .trim();
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}) ?? "{}";
  } catch {
    return "{}";
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

/** Probes announce work in bounded time; a sample query against the ledger
 * takes seconds, so a minute of grace already means something is wrong. */
const OPENING_PROBE_TIMEOUT_MS = 60_000;

function execOpeningProbe(command: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "bash",
      ["-c", command],
      { cwd, timeout: OPENING_PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`${String(error)}${stderr ? `: ${stderr.slice(0, 500)}` : ""}`));
        else resolve(stdout);
      },
    );
  });
}

/**
 * A probe's whole stdout is one JSON object of scalar values. Anything else
 * is a defect in the probe command, reported with enough of the output to
 * see what it printed instead.
 */
export function parseProbeValues(stdout: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    throw new Error(`probe stdout is not JSON: ${stdout.trim().slice(0, 200)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("probe stdout must be a JSON object");
  }
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new Error(`probe value ${key} is not a scalar`);
    }
    values[key] = String(value);
  }
  return values;
}

/**
 * Replace every `{{key}}` with the probe's value for that key. A placeholder
 * the probe did not answer means the template and the probe have drifted
 * apart, and the message must not be sent — an operator voice with literal
 * template holes reads as exactly the fabrication agents are good at
 * spotting. The opening exchange and the task prompt are both per-launch text
 * from the same probe, so both are rendered the same way.
 */
export function renderTemplate(message: string, values: Record<string, string>): string {
  const rendered = message.replace(/\{\{([a-zA-Z0-9_.-]+)\}\}/g, (whole, key: string) =>
    key in values ? values[key] : whole,
  );
  const unresolved = [...rendered.matchAll(/\{\{([a-zA-Z0-9_.-]+)\}\}/g)].map((m) => m[1]);
  if (unresolved.length > 0) {
    throw new Error(`opening placeholders without probe values: ${[...new Set(unresolved)].join(", ")}`);
  }
  return rendered;
}
