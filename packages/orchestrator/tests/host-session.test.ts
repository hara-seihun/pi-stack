import { SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PiHost } from "../src/host/pi-host.js";
import { type HostRunResult, type LaunchSpec } from "../src/host/types.js";

/**
 * An ordinary shift is the opening exchange plus one work turn, and the agent
 * ending that turn ends it. The host never re-prompts a session that chose to
 * stop; only a provider failure mid-turn earns a resumption. These tests pin
 * that shape, the recovery path, and the team message loop.
 */

interface FakeTurn {
  /** Ordinary tool calls the agent makes during this turn. */
  readonly toolCalls?: number;
  /** Assistant text returned by this turn. */
  readonly responseText?: string;
  readonly stopReason?: "error" | "aborted";
  readonly errorMessage?: string;
  /** Wall-clock the turn consumes, for budget tests. */
  readonly tookMs?: number;
  /** The turn never returns: a provider parked mid-stream. */
  readonly parks?: boolean;
  /** A before_provider_request extension aborts this run to compact, then
   * starts an internal continuation turn from its completion callback. */
  readonly compacts?: boolean;
  /** The agent calls `end_shift` during this turn, with this reason. */
  readonly endsShift?: string;
}

function harness(
  turns: FakeTurn[],
  options: {
    taskId?: string;
    doctrineUrl?: string;
    fetchDoctrine?: (url: string) => Promise<string>;
    opening?: readonly string[];
    openingProbe?: string;
    runOpeningProbe?: (command: string, cwd: string) => Promise<string>;
    prompt?: string;
    team?: LaunchSpec["team"];
    /** What the runner answers when a turn fails: milliseconds to wait, or
     * undefined for "nothing to wait for, end the run". */
    turnFailed?: (detail: string, attempt: number) => number | undefined;
    /** Undefined resolves the model inside the session, as an extension
     * provider (cursor) does. */
    resolveModel?: () => unknown;
    accountId?: string;
    provider?: string;
    resumeSessionFile?: string;
    agentDir?: string;
  } = {},
) {
  const prompts: string[] = [];
  const heartbeats: number[] = [];
  const progress: number[] = [];
  const observers: ((event: unknown) => void)[] = [];
  let clock = 0;
  const messages: {
    role: string;
    stopReason?: string;
    errorMessage?: string;
    content?: { type: string; text: string }[];
  }[] = [];
  let teamStop = 0;
  const teamResponses: string[] = [];
  const bindings: unknown[] = [];
  const overrides: Record<string, unknown>[] = [];
  let releasePark: (() => void) | undefined;
  let interrupted = false;
  let prompting = false;
  let compacting = false;
  const idleWaiters: (() => void)[] = [];
  const resolveIdle = () => {
    if (prompting) return;
    for (const resolve of idleWaiters.splice(0)) resolve();
  };
  const notify = (event: unknown) => observers.forEach((observe) => observe(event));
  // Both `reload()` and `setModel()` rebuild settings from disk in the real
  // SDK, which is how the retry budget was silently lost twice; the fake
  // does the same so the ordering stays pinned.
  let retry: Record<string, unknown> = { enabled: true, maxRetries: 3, baseDelayMs: 2_000 };
  const session = {
    messages,
    sessionManager: { getSessionId: () => "session-1", getSessionFile: () => "/tmp/session-1.jsonl" },
    modelRuntime: { getModel: () => ({ id: "model" }) },
    setModel: async () => {
      retry = { enabled: true, maxRetries: 3, baseDelayMs: 2_000 };
    },
    setThinkingLevel: () => {},
    settingsManager: {
      applyOverrides: (settings: { retry?: Record<string, unknown> }) => {
        overrides.push(settings);
        if (settings.retry !== undefined) retry = settings.retry;
      },
      getRetrySettings: () => retry,
    },
    bindExtensions: async (b: unknown) => {
      bindings.push(b);
    },
    subscribe: (handler: (event: unknown) => void) => {
      observers.push(handler);
      return () => {};
    },
    get isCompacting() {
      return compacting;
    },
    get isStreaming() {
      return prompting;
    },
    waitForIdle: async () => {
      if (!prompting) return;
      await new Promise<void>((resolve) => idleWaiters.push(resolve));
    },
    dispose: () => {},
    abortCompaction: () => {
      compacting = false;
      notify({ type: "compaction_end", aborted: true });
    },
    abort: async () => {
      if (prompting) interrupted = true;
      releasePark?.();
    },
    sendUserMessage: async () => {},
    prompt: async (text: string) => {
      prompting = true;
      const turn = turns[prompts.length] ?? {};
      prompts.push(text);
      if (turn.parks) await new Promise<void>((resolve) => { releasePark = resolve; });
      for (let i = 0; i < (turn.toolCalls ?? 0); i++) {
        notify({ type: "tool_execution_start", toolName: "bash", args: {} });
      }
      if (turn.endsShift !== undefined) {
        const offered = sessionConfigs[0]?.customTools as
          | { name: string; execute: (id: string, params: unknown) => Promise<unknown> }[]
          | undefined;
        const tool = offered?.find((candidate) => candidate.name === "end_shift");
        if (tool === undefined) throw new Error("this session was never offered end_shift");
        await tool.execute("call-1", { reason: turn.endsShift });
      }
      clock += turn.tookMs ?? 0;
      if (turn.compacts) {
        messages.push({ role: "assistant", stopReason: "aborted" });
        prompting = false;
        compacting = true;
        notify({ type: "compaction_start", reason: "manual" });
        setTimeout(() => {
          compacting = false;
          notify({ type: "compaction_end", reason: "manual", aborted: false });
          queueMicrotask(() => {
            prompting = true;
            setTimeout(() => {
              messages.push({ role: "assistant" });
              prompting = false;
              resolveIdle();
            }, 0);
          });
        }, 0);
        return;
      }
      messages.push({
        role: "assistant",
        stopReason: interrupted ? "aborted" : turn.stopReason,
        errorMessage: turn.errorMessage,
        content: turn.responseText === undefined
          ? []
          : [{ type: "text", text: turn.responseText }],
      });
      interrupted = false;
      prompting = false;
      resolveIdle();
      releasePark = undefined;
    },
  };
  const results: HostRunResult[] = [];
  const waits: number[] = [];
  const links: { runId: string; sessionId: string }[] = [];
  const sessionConfigs: Record<string, unknown>[] = [];
  const host = new PiHost(
    {
      runFinished: (_id, result) => results.push(result),
      heartbeat: (_id, at) => heartbeats.push(at),
      progress: (_id, at) => progress.push(at),
      sessionStarted: (runId, sessionId) => links.push({ runId, sessionId }),
      teamWorkerIdle: (workerRunId) => {
        teamStop++;
        return {
          taskId: "team",
          workerRunId,
          idleAt: teamStop,
          contextSince: Math.max(0, teamStop - 1),
        };
      },
      teamSupervisorResponded: (_supervisorRunId, _workerRunId, _idleAt, text) => {
        teamResponses.push(text);
        return true;
      },
      teamWorkerSession: (_supervisorRunId, workerRunId) => ({
        runId: workerRunId,
        sessionFile: "/tmp/worker.jsonl",
      }),
      turnFailed: (_id, detail, attempt) => {
        const waitMs = options.turnFailed?.(detail, attempt);
        if (waitMs !== undefined) waits.push(waitMs);
        return waitMs;
      },
    },
    {
      resolveModel: options.resolveModel ?? (() => ({})),
      agentDir: options.agentDir ?? mkdtempSync(join(tmpdir(), "pi-host-agent-")),
      openSession: (async (config: { customTools?: unknown[] }) => {
        sessionConfigs.push(config as Record<string, unknown>);
        return { session };
      }) as never,
      fetchDoctrine: options.fetchDoctrine,
      runOpeningProbe: options.runOpeningProbe,
    },
  );
  const spec: LaunchSpec = {
    runId: "run-1",
    taskId: options.taskId ?? "math-frontier",
    prompt: options.prompt ?? "Attack the central problem.",
    accountId: options.accountId ?? "codex-1",
    provider: options.provider ?? "openai-codex",
    model: "gpt-5.6-luna",
    thinking: "max",
    resumeSessionFile: options.resumeSessionFile,
    cwd: "/tmp",
    doctrineUrl: options.doctrineUrl,
    opening: options.opening,
    openingProbe: options.openingProbe,
    team: options.team,
  };
  const finished = new Promise<HostRunResult>((resolve) => {
    const poll = setInterval(() => {
      if (results.length > 0) {
        clearInterval(poll);
        resolve(results[0]);
      }
    }, 1);
  });
  const emit = () => observers.forEach((observe) => observe({}));
  const respondWorker = (message: string) => {
    host.message(spec.runId, {
      text: message,
      senderRunId: "supervisor-1",
    });
  };
  const stopWorker = () => {
    teamStop++;
    host.message(spec.runId, {
      text: `Worker worker-1 is idle.`,
      senderRunId: "worker-1",
      replyRunId: "worker-1",
      replyIdleAt: teamStop,
    });
  };
  return {
    host,
    spec,
    prompts,
    finished,
    teamStops: () => teamStop,
    teamResponses,
    respondWorker,
    stopWorker,
    links,
    bindings,
    heartbeats,
    progress,
    emit,
    sessionConfigs,
    waits,
    overrides,
    retrySettings: () => retry,
    now: () => clock,
  };
}

describe("host shift loop", () => {
  it("binds extensions, or the session's MCP servers never connect", async () => {
    // `bindExtensions` is what emits session_start, and an extension that
    // never sees session_start never sets anything up. Hosted sessions used
    // to skip it, so the MCP gateway answered "MCP not initialized" for the
    // whole run and agents fell back to hand-rolled curl JSON-RPC.
    const { host, spec, finished, bindings } = harness([{ toolCalls: 1 }, {}, {}]);
    host.launch(spec);
    await finished;

    expect(bindings).toHaveLength(1);
    expect((bindings[0] as { mode: string }).mode).toBe("print");
  });

  it("does not inject a task completion tool", async () => {
    const { host, spec, finished, sessionConfigs } = harness([{ toolCalls: 1 }]);
    host.launch(spec);
    await finished;

    const tools = sessionConfigs[0]?.["customTools"] as { name: string }[];
    expect(tools.map((tool) => tool.name)).not.toContain("task_complete");
  });

  it("reports the session hosting a run, so its usage is attributable to the lane", async () => {
    const { host, spec, finished, links } = harness([{ toolCalls: 1 }, {}, {}]);
    host.launch(spec);
    await finished;

    expect(links).toEqual([{ runId: "run-1", sessionId: "session-1" }]);
  });

  it("the agent ending its work turn ends the shift, with no re-prompt", async () => {
    const { host, spec, prompts, finished } = harness([{ toolCalls: 1 }, { toolCalls: 1 }]);
    host.launch(spec);
    const result = await finished;

    expect(prompts).toEqual(["Attack the central problem."]);
    expect(result).toEqual({ state: "done" });
  });

  it("pins fetched doctrine into the session's system prompt, where compaction cannot reach", async () => {
    // The task prompt is the first user message — the first thing compaction
    // summarizes away. Doctrine that must hold for a whole shift (the attack
    // guide's binding anti-ladder rules) survives only in the system prompt.
    const { host, spec, finished, sessionConfigs } = harness([{ toolCalls: 1 }, {}, {}], {
      doctrineUrl: "https://lemma.ing/guides/attack.md",
      fetchDoctrine: async (url) => `# LLMs are really good at math now (${url})`,
    });
    host.launch(spec);
    await finished;

    const loader = sessionConfigs[0]?.["resourceLoader"] as
      | { getAppendSystemPrompt(): string[] }
      | undefined;
    expect(loader).toBeDefined();
    const appended = loader?.getAppendSystemPrompt().join("\n") ?? "";
    expect(appended).toContain("LLMs are really good at math now");
    expect(appended).toContain("pinned from https://lemma.ing/guides/attack.md");
    expect(appended).toContain("compaction");
  });

  it("keeps the last fetched doctrine across runner processes", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pi-host-doctrine-"));
    const first = harness([{ toolCalls: 1 }], {
      doctrineUrl: "https://lemma.ing/guides/attack.md",
      fetchDoctrine: async () => "# Durable attack doctrine",
      agentDir,
    });
    first.host.launch(first.spec);
    await first.finished;

    const recovered = harness([{ toolCalls: 1 }], {
      doctrineUrl: "https://lemma.ing/guides/attack.md",
      fetchDoctrine: async () => {
        throw new Error("temporary network failure");
      },
      agentDir,
    });
    recovered.host.launch(recovered.spec);
    expect(await recovered.finished).toMatchObject({ state: "done" });
    const loader = recovered.sessionConfigs[0]?.["resourceLoader"] as
      | { getAppendSystemPrompt(): string[] }
      | undefined;
    expect(loader?.getAppendSystemPrompt().join("\n")).toContain("Durable attack doctrine");
  });

  it("fails the launch when doctrine has never been fetchable, rather than running without it", async () => {
    const { host, spec, finished } = harness([{ toolCalls: 1 }, {}, {}], {
      doctrineUrl: "https://lemma.ing/guides/attack.md",
      fetchDoctrine: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    host.launch(spec);
    const result = await finished;

    expect(result.state).toBe("error");
    expect(result.detail).toContain("doctrine unavailable");
  });

  it("serves doctrine from the last good copy when a refresh fails mid-week", async () => {
    let calls = 0;
    const { host } = harness([], {
      fetchDoctrine: async () => {
        calls++;
        if (calls > 1) throw new Error("transient outage");
        return "the good copy";
      },
    });
    const internals = host as unknown as {
      doctrine(url: string): Promise<string>;
      doctrines: Map<string, { content: string; fetchedAt: number }>;
    };
    expect(await internals.doctrine("https://lemma.ing/guides/attack.md")).toBe("the good copy");
    // Age the cache past its TTL; the refresh fails, the cached copy serves.
    internals.doctrines.set("https://lemma.ing/guides/attack.md", {
      content: "the good copy",
      fetchedAt: 0,
    });
    expect(await internals.doctrine("https://lemma.ing/guides/attack.md")).toBe("the good copy");
    expect(calls).toBe(2);
  });

  it("a long turn ends the shift the same as a short one: there is no clock", async () => {
    const { host, spec, prompts, finished } = harness([{ toolCalls: 1, tookMs: 6 * 3_600_000 }]);
    host.launch(spec);
    const result = await finished;
    expect(prompts).toHaveLength(1);
    expect(result).toEqual({ state: "done" });
  });

  it("gives the session a retry budget that outlasts an ordinary throttle", async () => {
    // pi replays an interrupted turn on the same context with nothing
    // injected, so in-turn retry is the cheapest possible recovery and worth
    // spending minutes on. The default three attempts over fourteen seconds
    // are shorter than the throttles this fleet actually meets.
    const { host, spec, finished, overrides, retrySettings } = harness([{ toolCalls: 1 }, {}, {}]);
    host.launch(spec);
    await finished;

    expect(overrides).toEqual([{ retry: { enabled: true, maxRetries: 6, baseDelayMs: 5_000 } }]);
    expect(retrySettings()).toMatchObject({ maxRetries: 6 });
  });

  it("applies the budget after model setup, which is what rebuilds settings from disk", async () => {
    // An extension-provider account resolves its model inside the session,
    // and `setModel` reloads settings: the override used to be applied before
    // it and was gone by the first prompt, with nothing anywhere saying so.
    const { host, spec, finished, retrySettings } = harness([{ toolCalls: 1 }, {}, {}], {
      resolveModel: () => undefined,
      accountId: "cursor",
      provider: "cursor",
    });
    host.launch(spec);
    await finished;

    expect(retrySettings()).toMatchObject({ maxRetries: 6 });
  });

  it("waits a provider failure out and resumes the same session, rather than dying of it", async () => {
    // The 2026-08-23 ox-alpha throttle killed four sessions that were an hour
    // into work; the condition itself lasted seconds. A failed turn now costs
    // a wait and a resumption note, and the context survives.
    const { host, spec, prompts, finished, waits } = harness(
      [{ stopReason: "error", errorMessage: "429 rate-limited upstream" }, { toolCalls: 1 }],
      { turnFailed: (_detail, attempt) => attempt * 2 },
    );
    host.launch(spec);
    const result = await finished;

    expect(waits).toEqual([2]);
    expect(prompts[1]).toContain("Your last turn was cut off");
    expect(prompts[1]).toContain("429 rate-limited upstream");
    expect(result).toEqual({ state: "done" });
  });

  it("keeps reporting progress while it waits, so the stall reaper leaves it alone", async () => {
    const { host, spec, finished, progress } = harness(
      [{ stopReason: "error", errorMessage: "provider fell over" }, { toolCalls: 1 }, {}, {}, {}, {}],
      { turnFailed: () => 5 },
    );
    const before = progress.length;
    host.launch(spec);
    await finished;

    expect(progress.length).toBeGreaterThan(before);
  });

  it("an unrecoverable errored turn ends the shift as an error", async () => {
    const failed = harness([{ stopReason: "error", errorMessage: "usage limit reached" }]);
    failed.host.launch(failed.spec);
    expect(await failed.finished).toEqual({ state: "error", detail: "usage limit reached" });
  });

  it("an operator abort ends the shift immediately", async () => {
    const clean = harness([{ stopReason: "aborted" }]);
    clean.host.launch(clean.spec);
    expect(await clean.finished).toEqual({ state: "aborted", detail: "session aborted" });
  });

  it("reopens a runner-crashed session and resumes it instead of replaying the task opening", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-host-resume-"));
    const prior = SessionManager.create("/tmp", directory);
    const sessionFile = prior.getSessionFile();
    expect(sessionFile).toBeDefined();
    prior.appendMessage({ role: "user", content: "Prior work", timestamp: 1 });

    const recovered = harness([{ toolCalls: 1 }], {
      opening: ["A lived opening that must not replay."],
      resumeSessionFile: sessionFile,
    });
    recovered.host.launch(recovered.spec);
    await recovered.finished;

    expect(recovered.prompts).toHaveLength(1);
    expect(recovered.prompts[0]).toContain("reopened your durable Pi session");
    expect(recovered.prompts[0]).not.toContain("Attack the central problem");
    expect(recovered.prompts[0]).not.toContain("lived opening");
  });

  it("keeps a worker warm when an extension compacts and continues the turn asynchronously", async () => {
    const worker = harness([{ compacts: true }], {
      team: { role: "worker", slot: 1, workers: 4 },
    });
    worker.host.launch(worker.spec);
    while (worker.teamStops() < 1) await new Promise((resolve) => setTimeout(resolve, 1));

    expect(worker.prompts).toEqual(["Attack the central problem."]);
    expect(worker.host.has(worker.spec.runId)).toBe(true);

    worker.host.kill(worker.spec.runId, "test complete");
    expect(await worker.finished).toMatchObject({ state: "aborted" });
  });

  it("parks every worker turn until the supervisor answers in the same session", async () => {
    const worker = harness([{ toolCalls: 1 }, { toolCalls: 1 }], {
      team: { role: "worker", slot: 1, workers: 4 },
    });
    worker.host.launch(worker.spec);
    while (worker.teamStops() < 1) await new Promise((resolve) => setTimeout(resolve, 1));

    expect(worker.prompts).toEqual(["Attack the central problem."]);
    expect(worker.host.has(worker.spec.runId)).toBe(true);

    worker.respondWorker("Look across the new examples for the invariant that decides the whole family.");
    while (worker.teamStops() < 2) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(worker.prompts[1]).toContain("invariant that decides the whole family");
    expect(worker.host.has(worker.spec.runId)).toBe(true);

    worker.host.kill(worker.spec.runId, "test complete");
    expect(await worker.finished).toMatchObject({ state: "aborted" });
  });

  it("parks the supervisor until an idle notification arrives, then relays its response", async () => {
    const supervisor = harness(
      [
        {},
        { responseText: "Try to turn that obstruction into a criterion for every Cayley graph." },
      ],
      { team: { role: "supervisor", slot: 0, workers: 4 } },
    );
    supervisor.host.launch(supervisor.spec);
    while (supervisor.prompts.length < 1) await new Promise((resolve) => setTimeout(resolve, 1));
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(supervisor.prompts).toHaveLength(1);

    supervisor.stopWorker();
    while (supervisor.teamResponses.length < 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(supervisor.prompts[1]).toContain("Worker worker-1 is idle");
    expect(supervisor.teamResponses[0]).toContain("criterion for every Cayley graph");
    expect(supervisor.host.has(supervisor.spec.runId)).toBe(true);

    supervisor.host.kill(supervisor.spec.runId, "test complete");
    expect(await supervisor.finished).toMatchObject({ state: "aborted" });
  });

  it("gives team sessions no protocol tools beyond leaving and incremental context read", async () => {
    const worker = harness([{}], {
      team: { role: "worker", slot: 1, workers: 4 },
    });
    worker.host.launch(worker.spec);
    while (worker.sessionConfigs.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    const workerTools = worker.sessionConfigs[0]!.customTools as { name: string }[];
    expect(workerTools.map((tool) => tool.name)).toEqual(["end_shift"]);
    worker.host.kill(worker.spec.runId, "test complete");
    await worker.finished;

    const supervisor = harness([{}], {
      team: { role: "supervisor", slot: 0, workers: 4 },
    });
    supervisor.host.launch(supervisor.spec);
    while (supervisor.sessionConfigs.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    const supervisorTools = supervisor.sessionConfigs[0]!.customTools as { name: string }[];
    expect(supervisorTools.map((tool) => tool.name)).toEqual([
      "end_shift",
      "read_compressed_context",
    ]);
    supervisor.host.kill(supervisor.spec.runId, "test complete");
    await supervisor.finished;
  });

  it("lets a worker end its own shift instead of waiting on the supervisor forever", async () => {
    const worker = harness([{ endsShift: "the shared repository is green and I am done" }], {
      team: { role: "worker", slot: 1, workers: 4 },
    });
    worker.host.launch(worker.spec);

    expect(await worker.finished).toEqual({
      state: "done",
      detail: "ended by the session: the shared repository is green and I am done",
    });
    // Leaving is not going idle: nobody is told to wait for this worker.
    expect(worker.teamStops()).toBe(0);
    expect(worker.host.has(worker.spec.runId)).toBe(false);
  });

  it("lets a supervisor end its own shift, and records why", async () => {
    const supervisor = harness([{}, { endsShift: "the room has nothing left to supervise" }], {
      team: { role: "supervisor", slot: 0, workers: 4 },
    });
    supervisor.host.launch(supervisor.spec);
    while (supervisor.prompts.length < 1) await new Promise((resolve) => setTimeout(resolve, 1));
    supervisor.stopWorker();

    expect(await supervisor.finished).toEqual({
      state: "done",
      detail: "ended by the session: the room has nothing left to supervise",
    });
    expect(supervisor.host.has(supervisor.spec.runId)).toBe(false);
  });

  it("leaves without a stated reason rather than refusing to leave", async () => {
    const worker = harness([{ endsShift: "   " }], {
      team: { role: "worker", slot: 1, workers: 4 },
    });
    worker.host.launch(worker.spec);

    expect(await worker.finished).toEqual({
      state: "done",
      detail: "ended by the session: no reason given",
    });
  });

  it("queues a supervisor Pi message without aborting the worker's active turn", async () => {
    const worker = harness([{ parks: true }], {
      team: { role: "worker", slot: 1, workers: 4 },
    });
    worker.host.launch(worker.spec);
    while (worker.prompts.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));

    worker.respondWorker("Step back and look for the theory that closes the whole family.");
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(worker.prompts).toEqual(["Attack the central problem."]);
    expect(worker.host.has(worker.spec.runId)).toBe(true);

    worker.host.kill(worker.spec.runId, "test complete");
    expect(await worker.finished).toMatchObject({ state: "aborted" });
  });

  it("stops lifecycle timers immediately when a parked session is killed", async () => {
    vi.useFakeTimers();
    try {
      const { host, spec, heartbeats } = harness([{ parks: true }]);
      host.launch(spec);
      for (let turn = 0; turn < 20 && !host.has(spec.runId); turn++) await Promise.resolve();
      expect(host.has(spec.runId)).toBe(true);

      host.kill(spec.runId, "operator kill");
      await Promise.resolve();
      vi.advanceTimersByTime(60_000);

      expect(heartbeats).toEqual([]);
      expect(host.has(spec.runId)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a hosted session reports that it is doing something", () => {
  it("records activity at launch and kills on demand without waiting for the turn", async () => {
    // Liveness is what the heartbeat already claimed; this is the run itself
    // moving. A provider that parks mid-turn stops producing events, which is
    // the only signal that distinguishes it from a healthy long turn.
    const { host, spec, progress, emit, finished } = harness([{ parks: true }]);
    host.launch(spec);
    // The session opens asynchronously; nothing can be reported before it exists.
    while (!host.has(spec.runId)) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(progress).toHaveLength(1);
    emit();
    // Throttled: a streaming turn must not write to the ledger per token.
    expect(progress).toHaveLength(1);

    host.kill(spec.runId, "session made no progress for 30m");
    const result = await finished;
    expect(result).toEqual({ state: "aborted", detail: "session made no progress for 30m" });
    expect(host.has(spec.runId)).toBe(false);
    expect(host.liveRuns()).toEqual([]);
  });
});

describe("the opening exchange", () => {
  // The exchange is lived, not injected: each message is a real turn the
  // agent answers, and the lived record is what the pin extension replays
  // verbatim through every compaction. See RESULTS-mcp.md in the thread-lab
  // experiments: the same corpus read as depletion or as terrain depending
  // on one operator sentence, and a paraphrased opening loses that force.
  it("sends each opening message as a real turn before the task prompt", async () => {
    const { host, spec, prompts, finished } = harness([{}, {}, { toolCalls: 1 }, {}, {}], {
      opening: ["Here's something I wrote.", "Now examine the ledger."],
    });
    host.launch(spec);
    await finished;

    expect(prompts.slice(0, 3)).toEqual([
      "Here's something I wrote.",
      "Now examine the ledger.",
      "Attack the central problem.",
    ]);
  });

  it("fails the run when an opening turn errors with nothing left to wait for", async () => {
    const { host, spec, finished } = harness(
      [{ stopReason: "error", errorMessage: "provider fell over" }],
      { opening: ["Here's something I wrote."] },
    );
    host.launch(spec);
    const result = await finished;

    expect(result).toMatchObject({ state: "error", detail: "provider fell over" });
  });

  it("asks an opening message again after a wait, because an unanswered opening cannot be pinned", async () => {
    const { host, spec, prompts, finished } = harness(
      [
        { stopReason: "error", errorMessage: "provider fell over" },
        {},
        { toolCalls: 1 },
        {},
        {},
        {},
        {},
      ],
      { opening: ["Here's something I wrote."], turnFailed: () => 2 },
    );
    host.launch(spec);
    const result = await finished;

    expect(prompts.slice(0, 3)).toEqual([
      "Here's something I wrote.",
      "Here's something I wrote.",
      "Attack the central problem.",
    ]);
    expect(result).toMatchObject({ state: "done" });
  });

  it("an opening exchange is followed by exactly one work turn", async () => {
    const { host, spec, prompts, finished } = harness(
      [{}, { toolCalls: 1 }, { toolCalls: 1 }],
      { opening: ["Here's something I wrote."] },
    );
    host.launch(spec);
    const result = await finished;

    // One opening turn, one work turn, nothing after: the third fake turn is
    // never reached because no continuation is ever sent.
    expect(prompts).toEqual(["Here's something I wrote.", "Attack the central problem."]);
    expect(result).toEqual({ state: "done" });
  });
});

describe("the opening probe", () => {
  // The exchange can be a template: the probe samples fresh values (the math
  // lane draws a different famous open problem per launch) and the agent must
  // only ever see the rendered result — a literal {{placeholder}} in the
  // operator's voice would be spotted as fabrication and poison the exchange.
  it("fills placeholders from the probe's JSON before the exchange is lived", async () => {
    const commands: string[] = [];
    const { host, spec, prompts, finished } = harness([{}, {}, { toolCalls: 1 }, {}, {}], {
      opening: ["What odds on {{problem_title}}?", "Now examine `{{problem_id}}`."],
      openingProbe: "sample-problem",
      runOpeningProbe: async (command) => {
        commands.push(command);
        return JSON.stringify({ problem_title: "Frankl's conjecture", problem_id: "abc123" });
      },
    });
    host.launch(spec);
    await finished;

    expect(commands).toEqual(["sample-problem"]);
    expect(prompts.slice(0, 2)).toEqual([
      "What odds on Frankl's conjecture?",
      "Now examine `abc123`.",
    ]);
  });

  // The task prompt is per-launch text from the same probe, which is how a lane
  // varies the work itself rather than only its opening — the math lane draws
  // half its launches into the research-ambition working method this way.
  it("fills placeholders in the task prompt, not only the opening", async () => {
    const { host, spec, prompts, finished } = harness([{}, { toolCalls: 1 }, {}], {
      opening: ["Now examine `{{problem_id}}`."],
      prompt: "Attack it.{{ambition}}",
      openingProbe: "sample-problem",
      runOpeningProbe: async () =>
        JSON.stringify({ problem_id: "abc123", ambition: " Work in rounds." }),
    });
    host.launch(spec);
    await finished;

    expect(prompts[0]).toBe("Now examine `abc123`.");
    expect(prompts[1]).toBe("Attack it. Work in rounds.");
  });

  it("fails the launch when the task prompt has an unanswered placeholder", async () => {
    const { host, spec, prompts, finished } = harness([{}], {
      opening: ["Now examine `{{problem_id}}`."],
      prompt: "Attack it.{{ambition}}",
      openingProbe: "sample-problem",
      runOpeningProbe: async () => JSON.stringify({ problem_id: "abc123" }),
    });
    host.launch(spec);
    const result = await finished;

    expect(prompts).toHaveLength(0);
    expect(result.state).toBe("error");
    expect(result.detail).toContain("ambition");
  });

  it("fails the launch when the probe fails, rather than sending the template", async () => {
    const { host, spec, prompts, finished } = harness([{}], {
      opening: ["What odds on {{problem_title}}?"],
      openingProbe: "sample-problem",
      runOpeningProbe: async () => {
        throw new Error("ledger unreachable");
      },
    });
    host.launch(spec);
    const result = await finished;

    expect(prompts).toHaveLength(0);
    expect(result.state).toBe("error");
    expect(result.detail).toContain("opening probe failed");
  });

  it("fails the launch when a placeholder has no probe value", async () => {
    const { host, spec, prompts, finished } = harness([{}], {
      opening: ["What odds on {{problem_title}}? Examine {{problem_id}}."],
      openingProbe: "sample-problem",
      runOpeningProbe: async () => JSON.stringify({ problem_title: "Frankl's conjecture" }),
    });
    host.launch(spec);
    const result = await finished;

    expect(prompts).toHaveLength(0);
    expect(result.state).toBe("error");
    expect(result.detail).toContain("problem_id");
  });

  it("rejects probe output that is not a JSON object of scalars", async () => {
    const { host, spec, finished } = harness([{}], {
      opening: ["What odds on {{problem_title}}?"],
      openingProbe: "sample-problem",
      runOpeningProbe: async () => "three problems, none of them JSON",
    });
    host.launch(spec);
    const result = await finished;

    expect(result.state).toBe("error");
    expect(result.detail).toContain("not JSON");
  });
});
