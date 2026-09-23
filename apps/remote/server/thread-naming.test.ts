import { describe, expect, test } from "bun:test";
import { generatedThreadName, localNamingPrompt, localReasoningEffort, namingOutcome, namingRequestId, namingStep, namingTranscript, parseThreadNamingModel, shouldNameThread, threadNamingModel } from "./thread-naming";
import type { CompletionRecord } from "pi-orchestrator/api";

describe("thread naming", () => {
  test("requires an explicitly configured OpenAI model", () => {
    expect(threadNamingModel("openai-codex/gpt-6-luna:low")).toBe("openai-codex/gpt-6-luna:low");
    expect(() => threadNamingModel(undefined)).toThrow("PI_REMOTE_THREAD_NAMING_MODEL");
    expect(() => threadNamingModel("openai-codex/gpt-6-luna")).toThrow("OpenAI model");
    expect(() => threadNamingModel("openrouter/stealth/ox-alpha:low")).toThrow("OpenAI model");
  });

  test("accepts numbered OpenAI account aliases used by the shared pool", () => {
    for (const provider of ["openai", "openai-2", "openai-codex", "openai-codex-12"]) {
      const selection = `${provider}/gpt-6-luna:low`;
      expect(threadNamingModel(` ${selection} `)).toBe(selection);
    }
    for (const selection of [
      "anthropic-2/claude-opus-5:low",
      "openai-codex-other/gpt-6-luna:low",
      "openai-codex-12/gpt-6-luna",
      "openai-codex-12/gpt-6-luna:invalid",
      "openai-codex-12/nested/model:low",
    ]) expect(() => threadNamingModel(selection)).toThrow("OpenAI model");
  });

  test("accepts a local engine and defaults its thinking to off", () => {
    expect(threadNamingModel("local/bonsai-halo/bonsai-2-27b")).toBe("local/bonsai-halo/bonsai-2-27b");
    expect(parseThreadNamingModel("local/bonsai-halo/bonsai-2-27b")).toEqual({ kind: "local", engine: "bonsai-halo", model: "bonsai-2-27b", thinkingLevel: "off" });
    expect(parseThreadNamingModel("local/bonsai-halo/bonsai-2-27b:low")).toEqual({ kind: "local", engine: "bonsai-halo", model: "bonsai-2-27b", thinkingLevel: "low" });
    expect(parseThreadNamingModel("openai-codex-11/gpt-6-luna:low")).toEqual({ kind: "completion", model: "gpt-6-luna", thinkingLevel: "low" });
    for (const selection of ["local/bonsai-2-27b", "local/Bonsai/bonsai-2-27b", "local/bonsai-halo/bonsai-2-27b:invalid"]) {
      expect(() => threadNamingModel(selection)).toThrow("local/ENGINE/MODEL");
    }
    expect(localReasoningEffort("off")).toBe("none");
    expect(localReasoningEffort("minimal")).toBe("none");
    expect(localReasoningEffort("medium")).toBe("medium");
    expect(localReasoningEffort("max")).toBe("xhigh");
  });

  test("builds a short local prompt from the opening request and the latest two messages", () => {
    const long = "x".repeat(1000);
    expect(localNamingPrompt([])).toBe("");
    expect(localNamingPrompt([{ role: "user", text: "  hello\n  world " }])).toBe("User: hello world");
    expect(localNamingPrompt([{ role: "user", text: long }, { role: "assistant", text: long }]))
      .toBe(`User: ${"x".repeat(600)}\nAgent: ${"x".repeat(300)}`);
    expect(localNamingPrompt([
      { role: "user", text: "first" }, { role: "assistant", text: "a1" }, { role: "user", text: "second" },
      { role: "assistant", text: "a2" }, { role: "user", text: "third" },
    ])).toBe("User: first\nAgent: a2\nUser: third");
    expect(localNamingPrompt([{ role: "assistant", text: "greeting" }, { role: "user", text: "ask" }])).toBe("User: ask");
  });

  test("keeps trying a numeric thread, then runs once per twentieth-message interval", () => {
    expect(shouldNameThread("950", 0, 0)).toBe(false);
    expect(shouldNameThread("950", 1, 0)).toBe(true);
    expect(shouldNameThread("950", 2, 0)).toBe(true);
    expect(shouldNameThread("Named Thread", 19, 2)).toBe(false);
    expect(shouldNameThread("Named Thread", 20, 2)).toBe(true);
    expect(shouldNameThread("Named Thread", 21, 20)).toBe(false);
    expect(shouldNameThread("Named Thread", 40, 20)).toBe(true);
  });

  test("a thread left numbered is due again even though its last attempt kept no receipt", () => {
    const numbered = { name: "47", messageCount: 6, namedAtMessageCount: 0, attemptedCount: 0, hasReceipt: false };
    expect(namingStep(numbered)).toBe("generate");
    expect(namingStep({ ...numbered, attemptedCount: 6 })).toBe("idle");
    expect(namingStep({ ...numbered, attemptedCount: 6, messageCount: 7 })).toBe("generate");
    expect(namingStep({ ...numbered, messageCount: 0 })).toBe("idle");
    expect(namingStep({ ...numbered, attemptedCount: 6, hasReceipt: true })).toBe("poll");
    expect(namingStep({ name: "Named Thread", messageCount: 7, namedAtMessageCount: 0, attemptedCount: 7, hasReceipt: false })).toBe("idle");
  });

  test("a request ID names one prompt, so a filled-in mirror submits instead of conflicting", () => {
    const input = { model: "luna", prompt: "User: hello" };
    expect(namingRequestId("thread-1", 2, input)).toBe(namingRequestId("thread-1", 2, { ...input }));
    expect(namingRequestId("thread-1", 2, input)).not.toBe(namingRequestId("thread-1", 2, { ...input, prompt: "User: hi" }));
    expect(namingRequestId("thread-1", 2, input)).toMatch(/^remote-name:thread-1:2:[0-9a-f]{12}$/);
    expect(namingTranscript([{ role: "user", text: "ask" }, { role: "assistant", text: "answer" }])).toBe("User: ask\n\nAgent: answer");
    expect(namingTranscript([{ role: "user", text: "abcdef" }], 3)).toBe("User: abc");
  });

  test("a rejected request is dropped and asked again; work in flight is resumed", () => {
    const record = (state: string, extra: Record<string, unknown> = {}) =>
      ({ ok: true as const, value: { requestId: "remote-name:t:1:abc", runId: "run", model: "luna", state, createdAt: 1, updatedAt: 2, ...extra } as unknown as CompletionRecord });
    expect(namingOutcome({ ok: false, error: { code: "invalid-request", message: "Invalid completion input." } }))
      .toEqual({ kind: "failed", message: "Invalid completion input.", keepReceipt: false, regenerate: true });
    expect(namingOutcome({ ok: false, error: { code: "request-conflict", message: "conflict" } }))
      .toMatchObject({ keepReceipt: false, regenerate: true });
    expect(namingOutcome({ ok: false, error: { code: "transport", message: "connection refused" } }))
      .toMatchObject({ kind: "failed", keepReceipt: true, regenerate: false });
    expect(namingOutcome(record("queued"))).toEqual({ kind: "pending" });
    expect(namingOutcome(record("running"))).toEqual({ kind: "pending" });
    expect(namingOutcome(record("completed", { result: { text: "Alert Delivery" } }))).toEqual({ kind: "title", text: "Alert Delivery" });
    expect(namingOutcome(record("failed", { error: { code: "provider", message: "provider said no" } })))
      .toEqual({ kind: "failed", message: "provider said no", keepReceipt: false, regenerate: false });
    expect(namingOutcome(record("cancelled"))).toMatchObject({ kind: "failed", keepReceipt: false, regenerate: false });
  });

  test("normalizes the model's first output line", () => {
    expect(generatedThreadName('## "Thread Naming".\nExplanation')).toBe("Thread Naming");
    expect(generatedThreadName("Title: Alert Delivery")).toBe("Alert Delivery");
    expect(generatedThreadName("Here is the title:\nEndpoint Workflow")).toBe("Endpoint Workflow");
    expect(() => generatedThreadName("1")).toThrow("invalid title");
    expect(() => generatedThreadName("x".repeat(61))).toThrow("invalid title");
    expect(() => generatedThreadName("Title:\n\"\"\n12")).toThrow("invalid title");
  });

  test("accepts short descriptive titles beyond the requested word count", () => {
    expect(generatedThreadName("AI Summit 2026 Website")).toBe("AI Summit 2026 Website");
    expect(generatedThreadName("AI Summit 2026 Landing Page")).toBe("AI Summit 2026 Landing Page");
    expect(generatedThreadName("x".repeat(60))).toBe("x".repeat(60));
  });
});
