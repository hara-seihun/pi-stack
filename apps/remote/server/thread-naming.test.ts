import { describe, expect, test } from "bun:test";
import { generatedThreadName, shouldNameThread, threadNamingModel } from "./thread-naming";

describe("thread naming", () => {
  test("requires an explicitly configured OpenAI model", () => {
    expect(threadNamingModel("openai-codex/gpt-5.6-luna:low")).toBe("openai-codex/gpt-5.6-luna:low");
    expect(() => threadNamingModel(undefined)).toThrow("PI_REMOTE_THREAD_NAMING_MODEL");
    expect(() => threadNamingModel("openai-codex/gpt-5.6-luna")).toThrow("OpenAI model");
    expect(() => threadNamingModel("openrouter/stealth/ox-alpha:low")).toThrow("OpenAI model");
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
    expect(() => generatedThreadName("This title has too many words")).toThrow("invalid title");
  });
});
