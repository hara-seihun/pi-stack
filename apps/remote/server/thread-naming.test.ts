import { describe, expect, test } from "bun:test";
import { generatedThreadName, shouldNameThread, threadNamingModel } from "./thread-naming";

describe("thread naming", () => {
  test("requires an explicitly configured OpenAI model", () => {
    expect(threadNamingModel("openai-codex/gpt-5.6-luna:low")).toBe("openai-codex/gpt-5.6-luna:low");
    expect(() => threadNamingModel(undefined)).toThrow("PI_REMOTE_THREAD_NAMING_MODEL");
    expect(() => threadNamingModel("openai-codex/gpt-5.6-luna")).toThrow("OpenAI model");
    expect(() => threadNamingModel("openrouter/stealth/ox-alpha:low")).toThrow("OpenAI model");
  });

  test("runs on the first conversational message and every twentieth message", () => {
    expect([0, 1, 2, 19, 20, 21, 40].filter(shouldNameThread)).toEqual([1, 20, 40]);
  });

  test("normalizes the model's first output line", () => {
    expect(generatedThreadName('## "Thread Naming".\nExplanation')).toBe("Thread Naming");
    expect(generatedThreadName("Title: Alert Delivery")).toBe("Alert Delivery");
    expect(() => generatedThreadName("1")).toThrow("invalid title");
    expect(() => generatedThreadName("This title has too many words")).toThrow("invalid title");
  });
});
