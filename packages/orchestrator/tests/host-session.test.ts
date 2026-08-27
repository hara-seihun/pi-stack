import { describe, expect, it, vi } from "vitest";
import { continuationFor, type TurnFacts } from "../src/host/continuations.js";
import { PiHost } from "../src/host/pi-host.js";
import { MAX_CHECK_INS, type HostRunResult, type LaunchSpec } from "../src/host/types.js";

/**
 * A launch is a shift, not a single turn.
 *
 * A model ends its turn the moment it writes a summary, and the host used to
 * end the run with it: standing research lanes told "submitting is a
 * checkpoint, not an exit" were torn down at the first checkpoint and
 * relaunched from an empty context. These tests pin the loop that lets the
 * instruction actually be obeyed, and the three ways a shift ends.
 */

interface FakeTurn {
  /** Reports the agent files during this turn. */
  readonly reports?: number;
  readonly stopReason?: "error" | "aborted";
  readonly errorMessage?: string;
  /** Wall-clock the turn consumes, for budget tests. */
  readonly tookMs?: number;
  /** The turn never returns: a provider parked mid-stream. */
  readonly parks?: boolean;
}

function harness(
  turns: FakeTurn[],
  options: {
    /** Check-ins the run has already spent, as the ledger would report them
     * for a shift some earlier process already kicked back. */
    checkInsSpent?: number;
    laneDrained?: () => boolean;
    taskId?: string;
    doctrineUrl?: string;
    fetchDoctrine?: (url: string) => Promise<string>;
    opening?: readonly string[];
    openingProbe?: string;
    runOpeningProbe?: (command: string, cwd: string) => Promise<string>;
    prompt?: string;
    selfPaced?: boolean;
    team?: LaunchSpec["team"];
    /** What the runner answers when a turn fails: milliseconds to wait, or
     * undefined for "nothing to wait for, end the run". */
    turnFailed?: (detail: string, attempt: number) => number | undefined;
    /** Undefined resolves the model inside the session, as an extension
     * provider (cursor) does. */
    resolveModel?: () => unknown;
    accountId?: string;
    provider?: string;
  } = {},
) {
  let spent = options.checkInsSpent ?? 0;
  const prompts: string[] = [];
  const heartbeats: number[] = [];
  const progress: number[] = [];
  const observers: ((event: unknown) => void)[] = [];
  let clock = 0;
  const messages: { role: string; stopReason?: string; errorMessage?: string }[] = [];
  let taskComplete: { execute: (id: string, params: unknown) => Promise<unknown> } | undefined;
  const bindings: unknown[] = [];
  const overrides: Record<string, unknown>[] = [];
  let releasePark: (() => void) | undefined;
  let interrupted = false;
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
    dispose: () => {},
    abort: async () => {
      interrupted = true;
      releasePark?.();
    },
    sendUserMessage: async () => {},
    prompt: async (text: string) => {
      const turn = turns[prompts.length] ?? {};
      prompts.push(text);
      if (turn.parks) await new Promise<void>((resolve) => { releasePark = resolve; });
      for (let i = 0; i < (turn.reports ?? 0); i++) {
        await taskComplete?.execute("call", {
          complete: true,
          summary: `report ${prompts.length}.${i}`,
        });
      }
      clock += turn.tookMs ?? 0;
      messages.push({
        role: "assistant",
        stopReason: interrupted ? "aborted" : turn.stopReason,
        errorMessage: turn.errorMessage,
      });
      interrupted = false;
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
      teamMembers: () => [],
      teamIntervene: () => {},
      laneDrained: options.laneDrained ?? (() => false),
      claimCheckIn: () => (spent++ < MAX_CHECK_INS ? true : false),
      turnFailed: (_id, detail, attempt) => {
        const waitMs = options.turnFailed?.(detail, attempt);
        if (waitMs !== undefined) waits.push(waitMs);
        return waitMs;
      },
    },
    {
      resolveModel: options.resolveModel ?? (() => ({})),
      openSession: (async (config: { customTools?: unknown[] }) => {
        sessionConfigs.push(config as Record<string, unknown>);
        taskComplete = config.customTools?.[0] as typeof taskComplete;
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
    cwd: "/tmp",
    doctrineUrl: options.doctrineUrl,
    opening: options.opening,
    openingProbe: options.openingProbe,
    selfPaced: options.selfPaced,
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
  return {
    host,
    spec,
    prompts,
    finished,
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
    const { host, spec, finished, bindings } = harness([{ reports: 1 }, {}, {}]);
    host.launch(spec);
    await finished;

    expect(bindings).toHaveLength(1);
    expect((bindings[0] as { mode: string }).mode).toBe("print");
  });

  it("reports the session hosting a run, so its usage is attributable to the lane", async () => {
    const { host, spec, finished, links } = harness([{ reports: 1 }, {}, {}]);
    host.launch(spec);
    await finished;

    expect(links).toEqual([{ runId: "run-1", sessionId: "session-1" }]);
  });

  it("keeps prompting the same session after a turn ends, and reports the newest record", async () => {
    const { host, spec, prompts, finished } = harness([
      { reports: 1 },
      { reports: 1 },
      {}, // nothing to report, which is not the same as nothing to do
      {},
      { reports: 1 },
    ]);
    host.launch(spec);
    const result = await finished;

    expect(prompts).toHaveLength(MAX_CHECK_INS + 1);
    expect(prompts[0]).toBe("Attack the central problem.");
    // The operator's own first message, verbatim, then her follow-ups while
    // the work flows — and honest permission to stop once a turn is quiet.
    expect(prompts[1]).toContain("take a step back");
    expect(prompts[1]).toContain("attack guide on the MCP");
    expect(prompts[2]).toContain("me again");
    expect(prompts[2]).not.toBe(prompts[1]);
    expect(prompts[3]).toContain("honest check-in");
    expect(result).toMatchObject({ state: "done", productive: true, detail: "report 5.0" });
  });

  it("does not send the frontier continuation to other lanes", async () => {
    const { host, spec, prompts, finished } = harness([{ reports: 1 }, {}, {}], {
      taskId: "math-review",
    });
    host.launch(spec);
    await finished;

    expect(prompts[1]).toContain("the next page of the queue");
    expect(prompts[1]).not.toContain("attack guide on the MCP");
    expect(prompts[2]).toContain("queue");
    expect(prompts[2]).not.toBe(prompts[1]);
  });

  it("pins fetched doctrine into the session's system prompt, where compaction cannot reach", async () => {
    // The task prompt is the first user message — the first thing compaction
    // summarizes away. Doctrine that must hold for a whole shift (the attack
    // guide's binding anti-ladder rules) survives only in the system prompt.
    const { host, spec, finished, sessionConfigs } = harness([{ reports: 1 }, {}, {}], {
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

  it("fails the launch when doctrine has never been fetchable, rather than running without it", async () => {
    const { host, spec, finished } = harness([{ reports: 1 }, {}, {}], {
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

  it("cycles each lane's flow bank instead of running out of messages", () => {
    const working = (): TurnFacts => ({
      toolCalls: 3,
      submissions: [],
      reported: true,
      reportedUnproductive: false,
    });
    for (const taskId of ["math-frontier", "math-review", "unregistered-lane"]) {
      const messages = Array.from({ length: 12 }, (_, i) =>
        continuationFor({
          taskId,
          turn: i + 1,
          turns: Array.from({ length: i + 1 }, working),
        }),
      );
      for (let i = 1; i < messages.length; i++) {
        expect(messages[i]).not.toBe(messages[i - 1]);
      }
      expect(new Set(messages).size).toBeGreaterThanOrEqual(4);
    }
  });

  it("asks nothing of a shift whose check-ins some earlier process already spent", async () => {
    // The budget belongs to the run, not to the worker hosting it: a session
    // adopted mid-flight cannot start the five over.
    const { host, spec, prompts, finished } = harness(
      Array.from({ length: 12 }, () => ({ reports: 1 })),
      { checkInsSpent: MAX_CHECK_INS },
    );
    host.launch(spec);
    const result = await finished;
    expect(prompts).toHaveLength(1);
    expect(result).toMatchObject({ state: "done", detail: "report 1.0" });
  });

  it("stops after its check-ins are spent, however productive and however long the turns ran", async () => {
    const { host, spec, prompts, finished } = harness(
      Array.from({ length: 12 }, () => ({ reports: 1, tookMs: 6 * 3_600_000 })),
    );
    host.launch(spec);
    const result = await finished;
    // The task prompt plus MAX_CHECK_INS check-ins, and no clock anywhere:
    // these turns took three days between them.
    expect(prompts).toHaveLength(MAX_CHECK_INS + 1);
    expect(result).toMatchObject({ state: "done", detail: "report 6.0" });
  });

  it("gives the session a retry budget that outlasts an ordinary throttle", async () => {
    // pi replays an interrupted turn on the same context with nothing
    // injected, so in-turn retry is the cheapest possible recovery and worth
    // spending minutes on. The default three attempts over fourteen seconds
    // are shorter than the throttles this fleet actually meets.
    const { host, spec, finished, overrides, retrySettings } = harness([{ reports: 1 }, {}, {}]);
    host.launch(spec);
    await finished;

    expect(overrides).toEqual([{ retry: { enabled: true, maxRetries: 6, baseDelayMs: 5_000 } }]);
    expect(retrySettings()).toMatchObject({ maxRetries: 6 });
  });

  it("applies the budget after model setup, which is what rebuilds settings from disk", async () => {
    // An extension-provider account resolves its model inside the session,
    // and `setModel` reloads settings: the override used to be applied before
    // it and was gone by the first prompt, with nothing anywhere saying so.
    const { host, spec, finished, retrySettings } = harness([{ reports: 1 }, {}, {}], {
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
      [
        { reports: 1 },
        { stopReason: "error", errorMessage: "429 rate-limited upstream" },
        { reports: 1 },
        {},
        {},
        {},
        {},
      ],
      { turnFailed: (_detail, attempt) => attempt * 2 },
    );
    host.launch(spec);
    const result = await finished;

    expect(waits).toEqual([2]);
    expect(prompts[2]).toContain("Your last turn was cut off");
    expect(prompts[2]).toContain("429 rate-limited upstream");
    // The resumption replaces the check-in rather than spending one: the
    // agent is being asked to continue a turn, not to report on it.
    expect(prompts[3]).toContain("me again");
    expect(result).toMatchObject({ state: "done", detail: "report 3.0" });
  });

  it("keeps reporting progress while it waits, so the stall reaper leaves it alone", async () => {
    const { host, spec, finished, progress } = harness(
      [{ stopReason: "error", errorMessage: "provider fell over" }, { reports: 1 }, {}, {}, {}, {}],
      { turnFailed: () => 5 },
    );
    const before = progress.length;
    host.launch(spec);
    await finished;

    expect(progress.length).toBeGreaterThan(before);
  });

  it("an errored turn ends the shift: error when nothing was banked, the report when something was", async () => {
    const failed = harness([{ stopReason: "error", errorMessage: "usage limit reached" }]);
    failed.host.launch(failed.spec);
    expect(await failed.finished).toEqual({ state: "error", detail: "usage limit reached" });

    const banked = harness([
      { reports: 1 },
      { stopReason: "error", errorMessage: "usage limit reached" },
      { reports: 1 },
    ]);
    banked.host.launch(banked.spec);
    const result = await banked.finished;
    expect(banked.prompts).toHaveLength(2);
    expect(result).toMatchObject({ state: "done", detail: "report 1.0" });
  });

  it("a lane that drains mid-shift ends instead of being re-prompted about work it no longer has", async () => {
    let queue = 2;
    const { host, spec, prompts, finished } = harness(
      [{ reports: 1 }, { reports: 1 }, { reports: 1 }],
      { laneDrained: () => --queue <= 0 },
    );
    host.launch(spec);
    const result = await finished;
    // Two turns, then the queue is empty: banked work is still the record.
    expect(prompts).toHaveLength(2);
    expect(result).toMatchObject({ state: "done", productive: true, detail: "report 2.0" });
  });

  it("an operator abort ends the shift immediately", async () => {
    const { host, spec, prompts, finished } = harness([
      { reports: 1 },
      { stopReason: "aborted" },
      { reports: 1 },
    ]);
    host.launch(spec);
    await finished;
    expect(prompts).toHaveLength(2);

    const clean = harness([{ stopReason: "aborted" }]);
    clean.host.launch(clean.spec);
    expect(await clean.finished).toEqual({ state: "aborted", detail: "session aborted" });
  });

  it("keeps team check-ins on whole-programme work rather than generic task picking", async () => {
    const worker = harness([{ reports: 1 }, {}], {
      team: { role: "worker", slot: 1, workers: 4, watchFor: [] },
    });
    worker.host.launch(worker.spec);
    await worker.finished;
    expect(worker.prompts[1]).toContain("whole theorem");
    expect(worker.prompts[1]).toContain("bounded case is working material");

    const supervisor = harness([{ reports: 1 }, {}], {
      team: { role: "supervisor", slot: 0, workers: 4, watchFor: [] },
    });
    supervisor.host.launch(supervisor.spec);
    await supervisor.finished;
    expect(supervisor.prompts[1]).toContain("Cycle through every live worker");
    expect(supervisor.prompts[1]).toContain("don't turn the programme into assignments");
  });

  it("a supervisor correction aborts the current turn and becomes the next user turn", async () => {
    const { host, spec, prompts, finished } = harness(
      [{ parks: true }, { reports: 1 }],
      {
        selfPaced: true,
        team: { role: "worker", slot: 1, workers: 4, watchFor: ["constant ladders"] },
      },
    );
    host.launch(spec);
    while (prompts.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));

    expect(host.intervene(spec.runId, "Step back and look for the theory that closes the whole family.")).toBe(true);
    const result = await finished;
    expect(prompts).toEqual([
      "Attack the central problem.",
      "Step back and look for the theory that closes the whole family.",
    ]);
    expect(result).toMatchObject({ state: "done", productive: true });
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
    const { host, spec, prompts, finished } = harness([{}, {}, { reports: 1 }, {}, {}], {
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
        { reports: 1 },
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

  it("self-paced: the agent ending its work turn ends the shift, with no check-in", async () => {
    const { host, spec, prompts, finished } = harness(
      [{}, { reports: 1 }, { reports: 1 }],
      { opening: ["Here's something I wrote."], selfPaced: true },
    );
    host.launch(spec);
    const result = await finished;

    // One opening turn, one work turn, nothing after: the third fake turn is
    // never reached because no continuation is ever sent.
    expect(prompts).toEqual(["Here's something I wrote.", "Attack the central problem."]);
    expect(result).toMatchObject({ state: "done", productive: true });
  });

  it("self-paced without a report is an unproductive done, not a retry loop", async () => {
    const { host, spec, prompts, finished } = harness([{}, {}], {
      opening: ["Here's something I wrote."],
      selfPaced: true,
    });
    host.launch(spec);
    const result = await finished;

    expect(prompts).toHaveLength(2);
    expect(result).toMatchObject({ state: "done", productive: false });
  });
});

describe("the opening probe", () => {
  // The exchange can be a template: the probe samples fresh values (the math
  // lane draws a different famous open problem per launch) and the agent must
  // only ever see the rendered result — a literal {{placeholder}} in the
  // operator's voice would be spotted as fabrication and poison the exchange.
  it("fills placeholders from the probe's JSON before the exchange is lived", async () => {
    const commands: string[] = [];
    const { host, spec, prompts, finished } = harness([{}, {}, { reports: 1 }, {}, {}], {
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
    const { host, spec, prompts, finished } = harness([{}, { reports: 1 }, {}], {
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
