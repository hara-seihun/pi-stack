import { describe, expect, it, vi } from "vitest";
import { continuationFor, type TurnFacts } from "../src/host/continuations.js";
import { openingPinExtension, PiHost, serializeOpening } from "../src/host/pi-host.js";
import type { HostRunResult, LaunchSpec } from "../src/host/types.js";

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
    sessionBudgetMs?: number;
    laneDrained?: () => boolean;
    taskId?: string;
    doctrineUrl?: string;
    fetchDoctrine?: (url: string) => Promise<string>;
    opening?: readonly string[];
    selfPaced?: boolean;
  } = {},
) {
  const prompts: string[] = [];
  const heartbeats: number[] = [];
  const progress: number[] = [];
  const observers: ((event: unknown) => void)[] = [];
  let clock = 0;
  const messages: { role: string; stopReason?: string; errorMessage?: string }[] = [];
  let taskComplete: { execute: (id: string, params: unknown) => Promise<unknown> } | undefined;
  const bindings: unknown[] = [];
  const session = {
    messages,
    sessionManager: { getSessionId: () => "session-1" },
    bindExtensions: async (b: unknown) => {
      bindings.push(b);
    },
    subscribe: (handler: (event: unknown) => void) => {
      observers.push(handler);
      return () => {};
    },
    dispose: () => {},
    abort: async () => {},
    sendUserMessage: async () => {},
    prompt: async (text: string) => {
      const turn = turns[prompts.length] ?? {};
      prompts.push(text);
      if (turn.parks) await new Promise(() => {});
      for (let i = 0; i < (turn.reports ?? 0); i++) {
        await taskComplete?.execute("call", {
          complete: true,
          summary: `report ${prompts.length}.${i}`,
        });
      }
      clock += turn.tookMs ?? 0;
      messages.push({
        role: "assistant",
        stopReason: turn.stopReason,
        errorMessage: turn.errorMessage,
      });
    },
  };
  const results: HostRunResult[] = [];
  const links: { runId: string; sessionId: string }[] = [];
  const sessionConfigs: Record<string, unknown>[] = [];
  const host = new PiHost(
    {
      runFinished: (_id, result) => results.push(result),
      heartbeat: (_id, at) => heartbeats.push(at),
      progress: (_id, at) => progress.push(at),
      sessionStarted: (runId, sessionId) => links.push({ runId, sessionId }),
      laneDrained: options.laneDrained ?? (() => false),
    },
    {
      resolveModel: () => ({}),
      sessionBudgetMs: options.sessionBudgetMs,
      openSession: (async (config: { customTools?: unknown[] }) => {
        sessionConfigs.push(config as Record<string, unknown>);
        taskComplete = config.customTools?.[0] as typeof taskComplete;
        return { session };
      }) as never,
      fetchDoctrine: options.fetchDoctrine,
    },
  );
  const spec: LaunchSpec = {
    runId: "run-1",
    taskId: options.taskId ?? "math-frontier",
    prompt: "Attack the central problem.",
    accountId: "codex-1",
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    thinking: "max",
    cwd: "/tmp",
    doctrineUrl: options.doctrineUrl,
    opening: options.opening,
    selfPaced: options.selfPaced,
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
      {}, // nothing to report
      {}, // still nothing: the lane is spent
      { reports: 1 }, // never reached
    ]);
    host.launch(spec);
    const result = await finished;

    expect(prompts).toHaveLength(4);
    expect(prompts[0]).toBe("Attack the central problem.");
    // The operator's own first message, verbatim, then her follow-ups while
    // the work flows — and honest permission to stop once a turn is quiet.
    expect(prompts[1]).toContain("take a step back");
    expect(prompts[1]).toContain("attack guide on the MCP");
    expect(prompts[2]).toContain("me again");
    expect(prompts[2]).not.toBe(prompts[1]);
    expect(prompts[3]).toContain("honest check-in");
    expect(result).toMatchObject({ state: "done", productive: true, detail: "report 2.0" });
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
          elapsedMs: 60_000,
          budgetMs: 4 * 3_600_000,
          turns: Array.from({ length: i + 1 }, working),
        }),
      );
      for (let i = 1; i < messages.length; i++) {
        expect(messages[i]).not.toBe(messages[i - 1]);
      }
      expect(new Set(messages).size).toBeGreaterThanOrEqual(4);
    }
  });

  it("a turn that reports keeps the shift alive however long it has been quiet before", async () => {
    const { host, spec, prompts, finished } = harness([
      { reports: 1 },
      {},
      { reports: 1 }, // breaks the idle streak
      {},
      {},
    ]);
    host.launch(spec);
    await finished;
    expect(prompts).toHaveLength(5);
  });

  it("stops when the session budget is spent, mid-productive", async () => {
    const { host, spec, prompts, finished } = harness(
      [
        { reports: 1, tookMs: 30 * 60_000 },
        { reports: 1, tookMs: 30 * 60_000 },
        { reports: 1, tookMs: 30 * 60_000 },
      ],
      { sessionBudgetMs: 0 },
    );
    host.launch(spec);
    const result = await finished;
    // Budget is checked after the turn, so exactly one turn runs.
    expect(prompts).toHaveLength(1);
    expect(result).toMatchObject({ state: "done", detail: "report 1.0" });
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

  it("fails the run when an opening turn errors, rather than working from a broken exchange", async () => {
    const { host, spec, finished } = harness(
      [{ stopReason: "error", errorMessage: "provider fell over" }],
      { opening: ["Here's something I wrote."] },
    );
    host.launch(spec);
    const result = await finished;

    expect(result).toMatchObject({ state: "error", detail: "provider fell over" });
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

describe("the opening pin", () => {
  type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
  const captureAll = () => {
    const handlers = new Map<string, Handler>();
    const bind = (pin: Parameters<typeof openingPinExtension>[0]) => {
      (openingPinExtension(pin) as { factory: (pi: unknown) => void }).factory({
        on: (name: string, fn: Handler) => {
          handlers.set(name, fn);
        },
      } as never);
      return handlers;
    };
    return bind;
  };
  const capture = () => {
    const bindAll = captureAll();
    return (pin: Parameters<typeof openingPinExtension>[0]) => {
      const handlers = bindAll(pin);
      return (event: unknown, ctx: unknown) => handlers.get("session_before_compact")!(event, ctx);
    };
  };
  const ctx = (summary = "WORK SUMMARY") => ({
    model: { id: "m" },
    modelRegistry: {
      complete: async () => ({
        content: [{ type: "text", text: summary }],
        usage: { input: 1, output: 1 },
      }),
    },
  });
  const message = (role: string, text: string) => ({
    role,
    content: [{ type: "text", text }],
  });

  it("replays the exchange verbatim at the head of every compaction summary", async () => {
    const bind = capture();
    const openingMessages = [
      message("user", "Here's something I wrote to fix your priors."),
      message("assistant", "I give myself 25%."),
    ];
    const handle = bind({ text: serializeOpening(openingMessages), messageCount: 2 });
    const result = (await handle(
      {
        preparation: {
          messagesToSummarize: [...openingMessages, message("user", "later work")],
          turnPrefixMessages: [],
          firstKeptEntryId: "entry-9",
          tokensBefore: 100_000,
        },
      },
      ctx(),
    )) as { compaction: { summary: string; firstKeptEntryId: string } };

    expect(result.compaction.firstKeptEntryId).toBe("entry-9");
    const summary = result.compaction.summary;
    expect(summary).toContain("Here's something I wrote to fix your priors.");
    expect(summary).toContain("I give myself 25%.");
    expect(summary).toContain("# Work since the opening exchange");
    expect(summary.indexOf("priors")).toBeLessThan(summary.indexOf("# Work since"));
    expect(summary).toContain("WORK SUMMARY");
  });

  it("registers the opening span with context-guard and withdraws it on shutdown", async () => {
    // Context-guard, not native compaction, is what actually cuts context on
    // large-window models; it protects the head span registered under the
    // session id in this global map.
    const bindAll = captureAll();
    const pin = { text: undefined, messageCount: 0 };
    const handlers = bindAll(pin);
    const guardCtx = { sessionManager: { getSessionId: () => "sess-1" } };
    const registry = (globalThis as never as { __piContextGuardProtect: Map<string, number> })
      .__piContextGuardProtect;

    // Before the opening turns complete there is nothing to protect.
    await handlers.get("context")!({ type: "context" }, guardCtx);
    expect(registry?.get("sess-1")).toBeUndefined();

    pin.messageCount = 7;
    await handlers.get("context")!({ type: "context" }, guardCtx);
    expect(registry.get("sess-1")).toBe(7);

    await handlers.get("session_shutdown")!({ type: "session_shutdown" }, guardCtx);
    expect(registry.get("sess-1")).toBeUndefined();
  });

  it("stays out of the way when there is no pinned opening", async () => {
    const bind = capture();
    const handle = bind({ text: undefined, messageCount: 0 });
    expect(
      await handle({ preparation: { messagesToSummarize: [], turnPrefixMessages: [] } }, ctx()),
    ).toBeUndefined();
  });

  it("steps aside on failure so compaction still happens without the pin", async () => {
    const bind = capture();
    const handle = bind({ text: "# pinned", messageCount: 0 });
    const failing = {
      model: { id: "m" },
      modelRegistry: {
        complete: async () => {
          throw new Error("provider unavailable");
        },
      },
    };
    expect(
      await handle(
        {
          preparation: {
            messagesToSummarize: [message("user", "work")],
            turnPrefixMessages: [],
            firstKeptEntryId: "e",
            tokensBefore: 1,
          },
        },
        failing,
      ),
    ).toBeUndefined();
  });
});

describe("serializeOpening", () => {
  it("keeps text, tool calls, and tool results whole", () => {
    const text = serializeOpening([
      { role: "user", content: [{ type: "text", text: "Examine erdos647." }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Looking now." },
          { type: "toolCall", name: "mcp", arguments: { tool: "math_get", args: { ref: "erdos647" } } },
        ],
      },
      { role: "toolResult", content: [{ type: "text", text: "certified to 6.2e17" }] },
    ]);

    expect(text).toContain("[User]:\nExamine erdos647.");
    expect(text).toContain("[Assistant]:\nLooking now.");
    expect(text).toContain('mcp({"tool":"math_get","args":{"ref":"erdos647"}})');
    expect(text).toContain("[Tool result]: certified to 6.2e17");
    expect(text).toContain("verbatim");
  });

  it("truncates only a pathological giant tool result", () => {
    const giant = "x".repeat(20_000);
    const text = serializeOpening([{ role: "toolResult", content: [{ type: "text", text: giant }] }]);
    expect(text).toContain("[truncated]");
    expect(text.length).toBeLessThan(17_000);
  });
});
