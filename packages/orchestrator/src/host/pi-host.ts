import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import type { HostEvents, HostManager, HostMessage, HostRunResult, LaunchSpec } from "./types.js";
import { describeWait, interruptedTurnPrompt } from "./continuations.js";
import { RunTranscript } from "./transcript.js";
import { openHostedSession, SESSION_RETRY } from "./session-lifecycle.js";
import { readCondensedSession, teamSystemPrompt } from "./team.js";

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

/** Waits are slept in slices so the run keeps reporting progress: a session
 * waiting out a provider is not the stalled session the runner reaps, and
 * only a signal on the same clock can tell those apart. */
const WAIT_SLICE_MS = 20_000;

export class PiHost implements HostManager {
  private readonly runtimes = new Map<
    string,
    {
      readonly session: AgentSession;
      readonly team: boolean;
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
  /** Team-to-team Pi messages waiting to become ordinary user turns. */
  private readonly teamMessages = new Map<string, HostMessage[]>();
  /** A team session with no turn in flight sleeps here until a Pi message
   * arrives from another member. */
  private readonly teamWakeups = new Map<string, () => void>();
  /** Team sessions that asked to leave, with whatever reason they gave. A
   * solo session ends its shift by ending its turn; a team session's settled
   * turn means "idle, tell the other member", so leaving needs its own word.
   * Without one, a worker whose supervisor keeps answering, or a supervisor
   * whose workers keep going idle, has no way out of the room at all. */
  private readonly leaving = new Map<string, string>();

  constructor(
    private readonly events: HostEvents,
    private readonly options: {
      /** pi agent dir (auth.json, models.json). Default: SDK default. */
      readonly agentDir?: string;
      /** Resolve a launch to a pi Model object. Alias accounts re-home the
       * family model onto the account's provider alias so credentials
       * resolve per account. Returning undefined defers to the session's own
       * model runtime, which is the only place extension-registered
       * providers exist. */
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
      /** Incremental condensed worker-context reader. */
      readonly readCondensed?: (sessionFile: string, since: string) => Promise<string>;
    },
  ) {}

  /** Last good copy of each doctrine document, so a transient fetch failure
   * mid-week does not strip doctrine from launches. A URL that has never
   * been fetched successfully fails the launch instead: a frontier session
   * without its binding anti-ladder doctrine is exactly the run the night of
   * 2026-08-21 taught us not to start. */
  private readonly doctrines = new Map<string, { content: string; fetchedAt: number }>();
  private readonly doctrineFetches = new Map<string, Promise<string>>();
  private static readonly DOCTRINE_TTL_MS = 15 * 60_000;

  private doctrine(url: string): Promise<string> {
    const active = this.doctrineFetches.get(url);
    if (active !== undefined) return active;
    const loading = this.loadDoctrine(url).finally(() => {
      if (this.doctrineFetches.get(url) === loading) this.doctrineFetches.delete(url);
    });
    this.doctrineFetches.set(url, loading);
    return loading;
  }

  private async loadDoctrine(url: string): Promise<string> {
    const memory = this.doctrines.get(url);
    if (memory !== undefined && Date.now() - memory.fetchedAt < PiHost.DOCTRINE_TTL_MS) {
      return memory.content;
    }
    const cachePath = join(
      this.options.agentDir ?? join(homedir(), ".pi", "agent"),
      "doctrines",
      `${createHash("sha256").update(url).digest("hex")}.md`,
    );
    let disk: { content: string; fetchedAt: number } | undefined;
    try {
      const [content, metadata] = await Promise.all([readFile(cachePath, "utf8"), stat(cachePath)]);
      disk = { content, fetchedAt: metadata.mtimeMs };
      if (memory === undefined && Date.now() - disk.fetchedAt < PiHost.DOCTRINE_TTL_MS) {
        this.doctrines.set(url, disk);
        return disk.content;
      }
    } catch {
      disk = undefined;
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
      const fetchedAt = Date.now();
      this.doctrines.set(url, { content, fetchedAt });
      const temporary = `${cachePath}.${process.pid}.${fetchedAt}`;
      await mkdir(dirname(cachePath), { recursive: true });
      await writeFile(temporary, content, { mode: 0o600 });
      await rename(temporary, cachePath);
      return content;
    } catch (thrown) {
      if (memory !== undefined) return memory.content;
      if (disk !== undefined) {
        this.doctrines.set(url, disk);
        return disk.content;
      }
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
    this.teamWakeups.get(runId)?.();
    const session = this.runtimes.get(runId)?.session;
    session?.abortCompaction();
    void session?.abort();
  }

  kill(runId: string, detail: string): void {
    const runtime = this.runtimes.get(runId);
    if (runtime === undefined) return;
    this.killed.add(runId);
    const transcript = this.transcripts.get(runId);
    transcript?.append("notice", { text: `Run killed: ${detail}` });
    transcript?.live({ activity: "IDLE" }, { force: true });
    runtime.session.abortCompaction();
    void runtime.session.abort();
    runtime.cancel();
    runtime.cleanup();
    this.events.runFinished(runId, { state: "aborted", detail }, Date.now());
  }

  /** Deliver a normal Pi message. Operator messages use Pi's native steering
   * while team messages wait for the recipient's current turn to settle. */
  message(runId: string, message: HostMessage): boolean {
    const runtime = this.runtimes.get(runId);
    if (runtime === undefined) return false;
    if (!runtime.team || (message.senderRunId === undefined && runtime.session.isStreaming)) {
      this.transcripts.get(runId)?.append("user", { text: message.text });
      void runtime.session.sendUserMessage(message.text, { deliverAs: "steer" }).catch(() => {
        // The ledger row remains authoritative if the session ended between
        // the runner tick and delivery.
      });
      return true;
    }
    const pending = this.teamMessages.get(runId) ?? [];
    pending.push(message);
    this.teamMessages.set(runId, pending);
    this.teamWakeups.get(runId)?.();
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
    const customTools: any[] = [];
    if (spec.team !== undefined) {
      customTools.push({
        name: "end_shift",
        label: "End shift",
        description:
          "End your shift and close this session. Call it whenever you want to stop: the work " +
          "is finished, there is nothing left you can usefully do here, or you would rather not " +
          "continue. Your current turn finishes normally and then the session ends; nothing " +
          "re-prompts you afterwards. The reason is recorded for the operator, not judged.",
        parameters: Type.Object({
          reason: Type.Optional(Type.String({ maxLength: 500 })),
        }),
        execute: async (_id: string, params: { reason?: string }) => {
          const reason = params.reason?.trim();
          this.leaving.set(spec.runId, reason === undefined || reason === "" ? "no reason given" : reason);
          return {
            content: [
              {
                type: "text" as const,
                text:
                  "Your shift ends when this turn settles. Finish anything you want written down " +
                  "first — files and notes outlive the session, this conversation does not.",
              },
            ],
            details: { runId: spec.runId },
          };
        },
      });
    }
    if (spec.team?.role === "supervisor") {
      customTools.push({
        name: "read_compressed_context",
        label: "Read compressed context",
        description:
          "Read one worker's incremental Pi session context beginning at the supplied timestamp from its idle notification.",
        parameters: Type.Object({
          runId: Type.String({ minLength: 1 }),
          since: Type.String({ minLength: 1 }),
        }),
        execute: async (_id: string, params: { runId: string; since: string }) => {
          const parsed = Date.parse(params.since);
          if (!Number.isFinite(parsed)) throw new Error("since must be an ISO timestamp");
          const worker = this.events.teamWorkerSession(spec.runId, params.runId);
          if (worker.sessionFile === undefined) {
            throw new Error(`${worker.runId} has no readable Pi session file yet`);
          }
          const condensed = this.options.readCondensed ?? readCondensedSession;
          const text = await condensed(worker.sessionFile, new Date(parsed).toISOString());
          return {
            content: [{ type: "text" as const, text }],
            details: { runId: worker.runId, since: new Date(parsed).toISOString() },
          };
        },
      });
    }

    // A builtin family resolves before the session exists; an extension
    // provider exists only inside the session's own model runtime,
    // because the extension that registers it is loaded per session.
    const preresolved = this.options.resolveModel(spec);
    const doctrine = spec.doctrineUrl === undefined ? undefined : await this.doctrine(spec.doctrineUrl);
    let resourceLoader: DefaultResourceLoader | undefined;
    if (doctrine !== undefined || spec.team !== undefined) {
      const appendSystemPrompt: string[] = [];
      if (doctrine !== undefined) {
        appendSystemPrompt.push(
          `# Lane doctrine (pinned from ${spec.doctrineUrl})\n\n` +
            "This document is pinned into your system prompt so it stays with " +
            "you after context compaction. It is binding for this lane.\n\n" +
            doctrine,
        );
      }
      if (spec.team !== undefined) {
        appendSystemPrompt.push(teamSystemPrompt(spec.team, spec.cwd ?? process.cwd()));
      }
      resourceLoader = new DefaultResourceLoader({
        cwd: spec.cwd ?? process.cwd(),
        agentDir: this.options.agentDir ?? join(homedir(), ".pi", "agent"),
        appendSystemPrompt,
      });
      await resourceLoader.reload();
    }
    const hosted = await openHostedSession({
      cwd: spec.cwd,
      sessionManager:
        spec.resumeSessionFile === undefined
          ? undefined
          : SessionManager.open(spec.resumeSessionFile, undefined, spec.cwd),
      agentDir: this.options.agentDir,
      resourceLoader,
      // The SDK's Model type is provider-internal; the resolver returns one.
      model: preresolved,
      thinkingLevel: spec.thinking,
      provider: spec.provider,
      modelId: spec.model,
      accountId: spec.accountId,
      customTools,
      openSession: this.options.openSession,
      onExtensionError: (extensionPath, error) => {
        transcript?.append("notice", {
          text: `Extension error (${extensionPath}): ${String(error)}`,
        });
      },
    });
    const session = hosted.session;
    let cancelRun!: () => void;
    const cancelled = new Promise<true>((resolve) => {
      cancelRun = () => resolve(true);
    });
    const interrupted = (operation: Promise<unknown>): Promise<boolean> =>
      Promise.race([operation.then(() => false), cancelled]);
    const waitForTeam = async (ready: () => boolean): Promise<boolean> => {
      while (!ready()) {
        let wake!: () => void;
        const signaled = new Promise<void>((resolve) => {
          wake = resolve;
        });
        this.teamWakeups.set(spec.runId, wake);
        if (ready()) wake();
        const killed = await interrupted(Promise.race([signaled, sleep(WAIT_SLICE_MS)]));
        if (this.teamWakeups.get(spec.runId) === wake) {
          this.teamWakeups.delete(spec.runId);
        }
        if (killed || this.aborting.has(spec.runId)) return false;
        this.events.progress(spec.runId, Date.now());
      }
      return true;
    };
    const disposers: (() => void)[] = [hosted.dispose];
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      this.runtimes.delete(spec.runId);
      this.transcripts.delete(spec.runId);
      this.aborting.delete(spec.runId);
      this.teamMessages.delete(spec.runId);
      this.teamWakeups.delete(spec.runId);
      this.leaving.delete(spec.runId);
      for (const dispose of disposers.reverse()) dispose();
    };
    this.runtimes.set(spec.runId, {
      session,
      team: spec.team !== undefined,
      cancel: cancelRun,
      cleanup,
    });
    try {
      this.events.sessionStarted(
        spec.runId,
        hosted.sessionId,
        session.sessionManager.getSessionFile() ?? undefined,
      );
      const retry = session.settingsManager.getRetrySettings();
      if (retry.maxRetries !== SESSION_RETRY.maxRetries) {
        const notice =
          `Session retry budget did not apply (${JSON.stringify(retry)}); this session dies of ` +
          "provider errors the SDK should have retried through.";
        console.warn(`${spec.runId.slice(0, 8)}: ${notice}`);
        transcript?.append("notice", { text: notice });
      }
      // Live transcript publication starts only after model resolution, so a
      // rejected model setup is never presented as an active run.
      if (transcript !== undefined) this.transcripts.set(spec.runId, transcript);
      const unsubscribe = transcript === undefined ? undefined : this.publish(transcript, session);
      if (unsubscribe !== undefined) disposers.push(unsubscribe);
      const stopProgress = this.trackProgress(spec.runId, session);
      disposers.push(stopProgress);
      const heartbeat = setInterval(
        () => this.events.heartbeat(spec.runId, Date.now()),
        HEARTBEAT_MS,
      );
      disposers.push(() => clearInterval(heartbeat));
      // An ordinary shift is the opening exchange plus one work turn, and the
      // agent ending that turn ends it. The host never re-prompts a session
      // that chose to stop: the continuation check-ins that used to do so
      // trained volume in flowing shifts and trapped agents in drained lanes.
      // Team sessions instead wait for Pi messages from one another, and
      // leave by calling `end_shift`, since their settled turn already means
      // "idle" rather than "finished".
      // Nothing here is timed: a turn may run as long as the agent keeps
      // working.
      // The opening exchange is lived, not injected: each message is a real
      // turn the agent answers with whatever tools it reaches for. Injecting a
      // transcript the agent never produced would be spotted and disbelieved.
      // A shift survives its provider. Everything below treats a failed turn
      // as weather to wait out rather than as the end of the session: the
      // runner prices the wait (see HostEvents.turnFailed), the host sleeps it
      // while still reporting progress, and the same context picks up where it
      // stopped. Only when the runner says there is nothing left to wait for
      // does the run end.
      let stalls = 0;
      for (const message of spec.resumeSessionFile === undefined ? opening : []) {
        for (;;) {
          transcript?.append("user", { text: message });
          if (await interrupted(promptAndSettle(session, message))) {
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
          break;
        }
      }
      let turn = 0;
      let envelope: HostMessage | undefined;
      let resume =
        spec.resumeSessionFile === undefined ||
        spec.team?.role === "supervisor" ||
        spec.team?.idleAt !== undefined
          ? undefined
          : interruptedTurnPrompt(
              "the process hosting this session stopped",
              "I reopened your durable Pi session with its full conversation and working context.",
            );
      for (;;) {
        const firstTeamTurn =
          spec.team !== undefined && spec.resumeSessionFile === undefined && turn === 0;
        if (spec.team !== undefined && !firstTeamTurn && resume === undefined && envelope === undefined) {
          transcript?.append("notice", { text: "Idle. Waiting for the next Pi message." });
          const awakened = await waitForTeam(
            () => (this.teamMessages.get(spec.runId)?.length ?? 0) > 0,
          );
          if (!awakened) return { state: "aborted", detail: "session aborted" };
          envelope = this.teamMessages.get(spec.runId)?.shift();
          if (envelope === undefined) continue;
        }
        const message =
          resume ??
          (spec.team !== undefined
            ? firstTeamTurn
              ? prompt
              : envelope!.text
            : prompt);
        transcript?.append("user", { text: message });
        if (await interrupted(promptAndSettle(session, message))) {
          return { state: "aborted", detail: "session killed" };
        }
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
          return { state: "error", detail };
        }
        if (last?.stopReason === "aborted") {
          return { state: "aborted", detail: "session aborted" };
        }
        stalls = 0;
        resume = undefined;
        const left = this.leaving.get(spec.runId);
        if (left !== undefined) {
          transcript?.append("notice", { text: `Session ended its own shift: ${left}` });
          return { state: "done", detail: `ended by the session: ${left}` };
        }
        if (spec.team !== undefined) {
          if (spec.team.role === "worker") {
            const idle = this.events.teamWorkerIdle(spec.runId);
            transcript?.append("notice", {
              text: `Worker idle as of ${new Date(idle.idleAt).toISOString()}.`,
            });
          } else if (
            envelope?.replyRunId !== undefined &&
            envelope.replyIdleAt !== undefined
          ) {
            const response = lastAssistantText(session);
            if (response === "") {
              this.teamMessages.set(spec.runId, [
                envelope,
                ...(this.teamMessages.get(spec.runId) ?? []),
              ]);
            } else {
              const delivered = this.events.teamSupervisorResponded(
                spec.runId,
                envelope.replyRunId,
                envelope.replyIdleAt,
                response,
              );
              if (delivered === "queued") {
                transcript?.append("notice", {
                  text: `Worker ${envelope.replyRunId} moved past this idle notification; response queued for its next turn.`,
                });
              } else if (delivered === "lost") {
                transcript?.append("notice", {
                  text: `Worker ${envelope.replyRunId} left the team before this response; not delivered.`,
                });
              }
            }
          }
          envelope = undefined;
          turn++;
          continue;
        }
        break;
      }
      return { state: "done" };
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

async function promptAndSettle(session: AgentSession, message: string): Promise<void> {
  await session.prompt(message);

  // An extension can call ctx.compact() from before_provider_request. Pi
  // aborts the current agent run, so prompt() resolves while manual
  // compaction is still running; the extension's onComplete callback then
  // starts the continuation turn. Disposing the session in that gap loses
  // both the compaction and the warm session. Let callback microtasks run,
  // wait for compaction, then wait for the turn they started.
  await sleep(0);
  for (;;) {
    if (session.isCompacting) await waitForCompaction(session);
    await sleep(0);
    if (session.isStreaming) {
      await session.waitForIdle();
      await sleep(0);
      continue;
    }
    if (!session.isCompacting) return;
  }
}

function waitForCompaction(session: AgentSession): Promise<void> {
  if (!session.isCompacting) return Promise.resolve();
  return new Promise((resolve) => {
    let unsubscribe = (): void => {};
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      unsubscribe();
      resolve();
    };
    unsubscribe = session.subscribe((event: any) => {
      if (event.type === "compaction_end") finish();
    });
    if (!session.isCompacting) finish();
  });
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

function lastAssistantText(session: AgentSession): string {
  const message = [...session.messages].reverse().find((entry) => entry.role === "assistant");
  return messageText(message);
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
