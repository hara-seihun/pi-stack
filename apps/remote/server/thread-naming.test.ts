import { describe, expect, test } from "bun:test";
import { generatedThreadName, shouldNameThread, threadNamingModel } from "./thread-naming";

describe("thread naming", () => {
  test("requires an explicitly configured OpenAI model", () => {
    expect(threadNamingModel("openai-codex/gpt-5.6-luna:low")).toBe("openai-codex/gpt-5.6-luna:low");
    expect(() => threadNamingModel(undefined)).toThrow("PI_REMOTE_THREAD_NAMING_MODEL");
    expect(() => threadNamingModel("openai-codex/gpt-5.6-luna")).toThrow("OpenAI model");
    expect(() => threadNamingModel("openrouter/stealth/ox-alpha:low")).toThrow("OpenAI model");
  });

  test("accepts numbered OpenAI account aliases used by the shared pool", () => {
    for (const provider of ["openai", "openai-2", "openai-codex", "openai-codex-12"]) {
      const selection = `${provider}/gpt-5.6-luna:low`;
      expect(threadNamingModel(` ${selection} `)).toBe(selection);
    }
    for (const selection of [
      "anthropic-2/claude-opus-5:low",
      "openai-codex-other/gpt-5.6-luna:low",
      "openai-codex-12/gpt-5.6-luna",
      "openai-codex-12/gpt-5.6-luna:invalid",
      "openai-codex-12/nested/model:low",
    ]) expect(() => threadNamingModel(selection)).toThrow("OpenAI model");
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
