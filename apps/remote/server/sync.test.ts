import { describe, expect, test } from "bun:test";
import { applyContextSplice, contextSplice, sha256 } from "./sync";

describe("context synchronization", () => {
  test("a verified byte splice reproduces arbitrary context changes", () => {
    const values = [
      ["", "hello"],
      ["before 🌙 after", "before 🌙 and more after"],
      [JSON.stringify({ messages: [{ role: "assistant", content: "one" }] }), JSON.stringify({ messages: [{ role: "assistant", content: "one two" }] })],
      ["abcdef", "abXYef"],
      ["long context that compaction removes", "short"],
    ];
    for (const [base, target] of values) {
      const splice = contextSplice(base, target);
      expect(applyContextSplice(base, splice)).toBe(target);
      expect(splice.targetHash).toBe(sha256(target));
    }
  });

  test("a stale or damaged splice is rejected", () => {
    const splice = contextSplice("one", "two");
    expect(() => applyContextSplice("stale", splice)).toThrow("base hash");
    expect(() => applyContextSplice("one", { ...splice, insertBase64: Buffer.from("damage").toString("base64") })).toThrow("target hash");
  });
});
