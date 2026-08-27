import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { TeamAuditVerdict } from "../tasks/types.js";
import type { HostEvents, HostManager, HostRunResult, LaunchSpec, TeamMember } from "./types.js";
import {
  continuationFor,
  describeWait,
  interruptedTurnPrompt,
  ShiftObserver,
} from "./continuations.js";
import { RunTranscript } from "./transcript.js";
import { openHostedSession, SESSION_RETRY } from "./session-lifecycle.js";
import {
  readCondensedSession,
  teamContinuation,
  teamSystemPrompt,
  teamWorkspaceExtension,
} from "./team.js";

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

function resolveTeamMember(members: readonly TeamMember[], ref: string): TeamMember {
  const exact = members.find((member) => member.runId === ref);
  if (exact !== undefined) return exact;
  const matches = members.filter((member) => member.runId.startsWith(ref));
  if (matches.length === 0) throw new Error(`${ref} is not on this team`);
  if (matches.length > 1) throw new Error(`${ref} matches more than one team member; use a longer run id`);
  return matches[0] as TeamMember;
}


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
  /** Supervisor corrections and worker-stop alerts waiting to become the next
   * ordinary user turn. The current turn is aborted when an item arrives. */
  private readonly interventions = new Map<string, string[]>();
  /** A team session with no turn in flight sleeps here until another member
   * creates the next conversation event. */
  private readonly teamWakeups = new Map<string, () => void>();

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
      /** Condensed worker-context reader. */
      readonly readCondensed?: (sessionFile: string) => Promise<string>;
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

  intervene(runId: string, text: string): boolean {
    const session = this.runtimes.get(runId)?.session;
    if (session === undefined) return false;
    const pending = this.interventions.get(runId) ?? [];
    pending.push(text);
    this.interventions.set(runId, pending);
    this.teamWakeups.get(runId)?.();
    session.abortCompaction();
    void session.abort().catch((thrown: unknown) => {
      this.transcripts.get(runId)?.append("notice", {
        text: `Could not abort the turn immediately: ${String(thrown)}`,
      });
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
        "productive=false only when this launch processed no work unit at all." +
        (spec.team === undefined
          ? ""
          : " In a team this is only a session report; it cannot place the programme completion marker."),
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
    const customTools: any[] = [taskComplete];
    if (spec.team?.role === "worker") {
      customTools.push({
        name: "team_audit",
        label: "Report completion audit",
        description:
          "Record your independent whole-programme verdict in the audit opened by the supervisor. Use pass only after trying to falsify the root theorem and replaying its load-bearing evidence; use objection for any unresolved contradiction, hidden conjecture, or certificate failure.",
        parameters: Type.Object({
          audit: Type.Integer({ minimum: 1 }),
          verdict: Type.Union([Type.Literal("pass"), Type.Literal("objection")]),
          summary: Type.String({ minLength: 1 }),
        }),
        execute: async (
          _id: string,
          params: { audit: number; verdict: TeamAuditVerdict; summary: string },
        ) => ({
          content: [{
            type: "text" as const,
            text: JSON.stringify(
              this.events.teamAudit(spec.runId, params.audit, params.verdict, params.summary),
              null,
              2,
            ),
          }],
          details: undefined,
        }),
      });
    }
    if (spec.team?.role === "supervisor") {
      customTools.push(
        {
          name: "team_members",
          label: "Team members",
          description: "List this team's worker and supervisor runs, progress times, and condensed-context availability.",
          parameters: Type.Object({}),
          execute: async () => ({
            content: [{
              type: "text" as const,
              text: JSON.stringify(this.events.teamMembers(spec.taskId), null, 2),
            }],
            details: undefined,
          }),
        },
        {
          name: "team_context",
          label: "Worker context",
          description: "Read one worker's Pi Stack compacted-context view. Cycle through every live worker with this tool.",
          parameters: Type.Object({ runId: Type.String({ minLength: 1 }) }),
          execute: async (_id: string, params: { runId: string }) => {
            const member = resolveTeamMember(this.events.teamMembers(spec.taskId), params.runId);
            if (member.role !== "worker") {
              throw new Error(`${params.runId} is not a worker on this team`);
            }
            if (member.sessionFile === undefined) {
              throw new Error(`${member.runId} has no readable Pi session file yet`);
            }
            const condensed = this.options.readCondensed ?? readCondensedSession;
            const text = await condensed(member.sessionFile);
            return { content: [{ type: "text" as const, text }], details: { runId: member.runId } };
          },
        },
        {
          name: "team_completion",
          label: "Team completion",
          description:
            "Read or change the durable whole-programme completion marker. begin_audit sends the same independent falsification request to every worker. Never use it to assign leaves. complete is accepted only after every worker slot has passed the current audit; withdraw returns the room to ordinary work when an objection lands.",
          parameters: Type.Object({
            action: Type.Union([
              Type.Literal("status"),
              Type.Literal("begin_audit"),
              Type.Literal("withdraw"),
              Type.Literal("complete"),
            ]),
            summary: Type.Optional(Type.String({ minLength: 1 })),
          }),
          execute: async (
            _id: string,
            params: {
              action: "status" | "begin_audit" | "withdraw" | "complete";
              summary?: string;
            },
          ) => {
            if (params.action !== "status" && params.summary === undefined) {
              throw new Error(`${params.action} needs a summary`);
            }
            const status = params.action === "status"
              ? this.events.teamCompletion(spec.taskId)
              : this.events.teamCompletionAction(spec.runId, params.action, params.summary!);
            return {
              content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }],
              details: undefined,
            };
          },
        },
        {
          name: "team_intervene",
          label: "Intervene with worker",
          description:
            "Send one worker its next warm programme-level message. A worker that has stopped cannot continue until you answer with this tool. A worker still mid-turn is interrupted, so proactive corrections remain rare and should follow a concrete warning sign.",
          parameters: Type.Object({
            runId: Type.String({ minLength: 1 }),
            message: Type.String({ minLength: 1 }),
          }),
          execute: async (_id: string, params: { runId: string; message: string }) => {
            const member = resolveTeamMember(this.events.teamMembers(spec.taskId), params.runId);
            if (member.role !== "worker") {
              throw new Error(`${params.runId} is not a worker on this team`);
            }
            const result = this.events.teamIntervene(spec.runId, member.runId, params.message);
            return {
              content: [{
                type: "text" as const,
                text: result.respondedToStop
                  ? `Response to ${member.runId} stop ${result.stop} queued. The worker can continue when its runner delivers your message.`
                  : `Queued for ${member.runId}. Its runner will abort the in-flight turn before delivering the message.`,
              }],
              details: result,
            };
          },
        },
      );
    }

    // A builtin family resolves before the session exists; an extension
    // provider (cursor) exists only inside the session's own model runtime,
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
        ...(spec.team === undefined
          ? {}
          : { extensionFactories: [teamWorkspaceExtension(spec.cwd ?? process.cwd(), spec.team.role)] }),
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
    const queueStopReminder = (): boolean => {
      if (spec.team?.role !== "supervisor") return false;
      if ((this.interventions.get(spec.runId)?.length ?? 0) > 0) return true;
      const waiting = this.events
        .teamMembers(spec.taskId)
        .filter((member) => member.role === "worker" && member.waiting);
      if (waiting.length === 0) return false;
      const pending = waiting.map(
        (worker) =>
          `- ${worker.runId}, stop ${worker.stop}` +
          (worker.stoppedAt === undefined
            ? ""
            : ` at ${new Date(worker.stoppedAt).toISOString()}`),
      );
      this.interventions.set(spec.runId, [[
        "These workers have stopped and cannot continue until you respond:",
        ...pending,
        "Read each worker's current context, then call team_intervene with the next warm programme-level message for every waiting worker.",
      ].join("\n")]);
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
      this.interventions.delete(spec.runId);
      this.teamWakeups.delete(spec.runId);
      for (const dispose of disposers.reverse()) dispose();
    };
    this.runtimes.set(spec.runId, { session, cancel: cancelRun, cleanup });
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
          observer.endTurn();
          break;
        }
      }
      let turn = 0;
      let resume =
        spec.resumeSessionFile === undefined
          ? undefined
          : interruptedTurnPrompt(
              "the process hosting this session stopped",
              "I reopened your durable Pi session with its full conversation and working context.",
            );
      for (;;) {
        // The lane's check-in (see continuations.ts) is generated from the
        // observed shift, so the message answers what the agent actually did
        // rather than firing a fixed sequence on a timer. A resumption note
        // pre-empts it: a turn the provider cut off was not a turn the agent
        // finished, and asking it "what did you land?" would be a lie about
        // what just happened.
        const intervention = this.interventions.get(spec.runId)?.shift();
        const message =
          intervention ??
          resume ??
          (turn === 0
            ? prompt
            : spec.team === undefined
              ? continuationFor({
                  taskId: spec.taskId,
                  turn,
                  turns: observer.turns(),
                })
              : teamContinuation(spec.team.role));
        transcript?.append("user", { text: message });
        if (await interrupted(promptAndSettle(session, message))) {
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
          // A supervisor correction deliberately aborts the in-flight turn.
          // Its queued text becomes the next ordinary user turn in this same
          // loop, preserving the session rather than turning intervention
          // into termination.
          if ((this.interventions.get(spec.runId)?.length ?? 0) > 0) {
            resume = undefined;
            continue;
          }
          if (report === undefined) return { state: "aborted", detail: "session aborted" };
          break;
        }
        stalls = 0;
        resume = undefined;
        observer.endTurn();
        if (spec.team !== undefined) {
          if (this.events.laneDrained(spec.taskId)) {
            transcript?.append("notice", {
              text: "The team's unanimous completion marker is set; ending this session.",
            });
            break;
          }
          if (spec.team.role === "worker") {
            const stopped = this.events.teamStopped(spec.runId);
            transcript?.append("notice", {
              text: `Turn ${stopped.stop} finished. Waiting for the supervisor's next message.`,
            });
            const resumed = await waitForTeam(
              () =>
                this.events.laneDrained(spec.taskId) ||
                (!this.events.teamWaiting(spec.runId) &&
                  (this.interventions.get(spec.runId)?.length ?? 0) > 0),
            );
            if (!resumed) return { state: "aborted", detail: "session aborted" };
          } else {
            if (!queueStopReminder()) {
              transcript?.append("notice", {
                text: "All workers are moving. Waiting for the next worker to stop.",
              });
              const awakened = await waitForTeam(
                () =>
                  this.events.laneDrained(spec.taskId) ||
                  (this.interventions.get(spec.runId)?.length ?? 0) > 0 ||
                  this.events
                    .teamMembers(spec.taskId)
                    .some((member) => member.role === "worker" && member.waiting),
              );
              if (!awakened) return { state: "aborted", detail: "session aborted" };
              queueStopReminder();
            }
          }
          if (this.events.laneDrained(spec.taskId)) break;
          turn++;
          continue;
        }
        // The abort can race with a turn that was already finishing. A queued
        // operator correction still gets the next user turn rather than
        // disappearing at a self-paced or check-in boundary.
        if ((this.interventions.get(spec.runId)?.length ?? 0) > 0) continue;
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
