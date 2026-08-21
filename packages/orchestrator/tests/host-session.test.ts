import { describe, expect, it } from "vitest";
import { PiHost } from "../src/host/pi-host.js";
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
}

function harness(
  turns: FakeTurn[],
  options: { sessionBudgetMs?: number; laneDrained?: () => boolean } = {},
) {
  const prompts: string[] = [];
  let clock = 0;
  const messages: { role: string; stopReason?: string; errorMessage?: string }[] = [];
  let taskComplete: { execute: (id: string, params: unknown) => Promise<unknown> } | undefined;
  const session = {
    messages,
    sessionManager: { getSessionId: () => "session-1" },
    subscribe: () => () => {},
    dispose: () => {},
    abort: async () => {},
    sendUserMessage: async () => {},
    prompt: async (text: string) => {
      const turn = turns[prompts.length] ?? {};
      prompts.push(text);
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
  const host = new PiHost(
    {
      runFinished: (_id, result) => results.push(result),
      heartbeat: () => {},
      sessionStarted: (runId, sessionId) => links.push({ runId, sessionId }),
      laneDrained: options.laneDrained ?? (() => false),
    },
    {
      resolveModel: () => ({}),
      sessionBudgetMs: options.sessionBudgetMs,
      openSession: (async (config: { customTools?: unknown[] }) => {
        taskComplete = config.customTools?.[0] as typeof taskComplete;
        return { session };
      }) as never,
    },
  );
  const spec: LaunchSpec = {
    runId: "run-1",
    taskId: "frontier",
    prompt: "Attack the central problem.",
    accountId: "codex-1",
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    thinking: "max",
    cwd: "/tmp",
  };
  const finished = new Promise<HostRunResult>((resolve) => {
    const poll = setInterval(() => {
      if (results.length > 0) {
        clearInterval(poll);
        resolve(results[0]);
      }
    }, 1);
  });
  return { host, spec, prompts, finished, links, now: () => clock };
}

describe("host shift loop", () => {
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
    // The continuation is a pointer back to the work, not a new task.
    expect(prompts[1]).toContain("still live");
    expect(prompts[1]).toBe(prompts[2]);
    expect(result).toMatchObject({ state: "done", productive: true, detail: "report 2.0" });
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
});
