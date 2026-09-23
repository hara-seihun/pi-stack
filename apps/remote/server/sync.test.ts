import { describe, expect, test } from "bun:test";
import { applyContextSplice, contextSplice, restoreContextSplices, sha256 } from "./sync";

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

  test("large shared ranges and multi-patch restoration preserve byte boundaries", () => {
    const base = "日本".repeat(30_000);
    for (const at of [0, 1, 65_535, 65_536, base.length - 1, base.length]) {
      const target = `${base.slice(0, at)}🌙${base.slice(at)}`;
      expect(applyContextSplice(base, contextSplice(base, target))).toBe(target);
    }
    const values = [base, `start ${base} end`, `${base.slice(0, 65_536)}🌙${base.slice(65_537)}`, "", "a", "あ", "日本 🌙"];
    const splices = values.slice(1).map((value, index) => contextSplice(values[index], value));
    for (let count = 0; count <= splices.length; count++) {
      expect(restoreContextSplices(base, splices.slice(0, count))).toEqual({ ok: true, document: values[count], hash: sha256(values[count]) });
    }
    expect(restoreContextSplices("stale", splices).ok).toBe(false);
    const patch = contextSplice("abc", "abcd");
    expect(restoreContextSplices("abc", [{ ...patch, insertBase64: "ZQ==" }]).ok).toBe(false);
    expect(restoreContextSplices("abc", [{ ...patch, prefixBytes: -1 }]).ok).toBe(false);
    expect(restoreContextSplices("abc", [patch, patch]).ok).toBe(false);
  });

  test("a stale or damaged splice is rejected", () => {
    const splice = contextSplice("one", "two");
    expect(() => applyContextSplice("stale", splice)).toThrow("base hash");
    expect(() => applyContextSplice("one", { ...splice, insertBase64: Buffer.from("damage").toString("base64") })).toThrow("target hash");
  });
});
