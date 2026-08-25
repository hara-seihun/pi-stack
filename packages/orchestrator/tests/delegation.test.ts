import { describe, expect, it } from "vitest";
import { Delegator } from "../src/host/delegation.js";
import { nestedSession, registerNestedSession } from "../src/host/session-context.js";
import { Ledger } from "../src/ledger/ledger.js";

interface FakeSessionControl {
  readonly config: Record<string, unknown>;
  readonly session: Record<string, any>;
  finish(text: string): void;
}

function fakeSessions() {
  const opened: FakeSessionControl[] = [];
  let sequence = 0;
  const openSession = async (config: Record<string, unknown>) => {
    const id = `child-${++sequence}`;
    let finishPrompt!: () => void;
    const promptFinished = new Promise<void>((resolve) => (finishPrompt = resolve));
    const session: Record<string, any> = {
      messages: [],
      sessionManager: { getSessionId: () => id },
      bindExtensions: async () => {},
      settingsManager: {
        applyOverrides: () => {},
        getRetrySettings: () => ({ maxRetries: 6 }),
      },
      modelRuntime: { getModel: () => undefined },
      prompt: async () => promptFinished,
      abort: async () => finishPrompt(),
      dispose: () => {},
    };
    const control = {
      config,
      session,
      finish: (text: string) => {
        session.messages.push({
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text }],
          usage: {
            input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        });
        finishPrompt();
      },
    };
    opened.push(control);
    return { session };
  };
  return { opened, openSession: openSession as never };
}

const parent = {
  cwd: "/work/project",
  model: { provider: "anthropic-2", id: "opus" } as never,
  thinkingLevel: "high",
  tools: ["read", "bash", "delegate"],
  sessionId: "root-session",
};

describe("single-shot delegation", () => {
  it("opens an isolated session with inherited runtime choices and returns one final answer", async () => {
    const ledger = Ledger.open(":memory:");
    ledger.upsertAccount({ id: "anthropic-2", provider: "anthropic" });
    ledger.upsertTask({ id: "lane", tiers: [{ tier: "standard", weight: 1 }], demandConstant: 1, prompt: "go" });
    const run = ledger.createRun({
      taskId: "lane", tier: "standard", accountId: "anthropic-2", model: "opus",
      provider: "anthropic", at: 1,
    });
    ledger.linkRunSession(run, parent.sessionId, 1);
    const fake = fakeSessions();
    const delegator = new Delegator(ledger, { openSession: fake.openSession, agentDir: "/agent" });

    const answerPromise = delegator.run({ task: "Inspect the parser", cwd: "packages/core" }, parent);
    while (fake.opened.length === 0) await Promise.resolve();
    const child = fake.opened[0]!;
    await Promise.resolve();
    expect(child.config).toMatchObject({
      cwd: "/work/project/packages/core",
      agentDir: "/agent",
      model: parent.model,
      thinkingLevel: "high",
      tools: ["read", "bash", "delegate"],
    });
    expect(child.config.sessionManager).toBeDefined();
    expect(nestedSession("child-1")).toEqual({
      parentSessionId: "root-session",
      rootSessionId: "root-session",
    });
    child.finish("The parser is correct.");

    await expect(answerPromise).resolves.toMatchObject({
      text: "The parser is correct.",
      sessionId: "child-1",
      usage: { input: 10, output: 5, totalTokens: 15 },
    });
    expect(nestedSession("child-1")).toBeUndefined();
    expect(ledger.sessionsForRun(run)[1]).toMatchObject({
      sessionId: "child-1",
      parentSessionId: "root-session",
    });
  });

  it("serializes sibling calls and propagates cancellation into the active child", async () => {
    const ledger = Ledger.open(":memory:");
    const fake = fakeSessions();
    const delegator = new Delegator(ledger, { openSession: fake.openSession });
    const firstAbort = new AbortController();
    const first = delegator.run({ task: "first" }, parent, firstAbort.signal);
    const second = delegator.run({ task: "second" }, parent);
    while (fake.opened.length === 0) await Promise.resolve();
    expect(fake.opened).toHaveLength(1);

    firstAbort.abort();
    await expect(first).rejects.toThrow(/cancelled/);
    while (fake.opened.length < 2) await Promise.resolve();
    expect(fake.opened).toHaveLength(2);
    fake.opened[1]!.finish("second answer");
    await expect(second).resolves.toMatchObject({ text: "second answer" });
  });

  it("tracks recursive ancestry to the same root", () => {
    const removeChild = registerNestedSession("child", "root");
    const removeGrandchild = registerNestedSession("grandchild", "child");
    expect(nestedSession("grandchild")).toEqual({
      parentSessionId: "child",
      rootSessionId: "root",
    });
    removeGrandchild();
    removeChild();
  });
});
