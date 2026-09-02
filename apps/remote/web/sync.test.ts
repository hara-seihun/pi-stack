import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { contextSplice } from "../server/sync";
import { updateDocument } from "./src/sync";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

describe("browser resumable synchronization", () => {
  test("verifies full documents and clears them", async () => {
    const document = JSON.stringify({ messages: [{ content: "hello" }] });
    const current = await updateDocument(null, { kind: "full", document, hash: hash(document), capturedAt: 12 });
    expect(current).toEqual({ document, hash: hash(document), capturedAt: 12 });
    expect(await updateDocument(current, null)).toBe(current);
    expect(await updateDocument(current, { kind: "clear" })).toBeNull();
    await expect(updateDocument(null, { kind: "full", document, hash: "wrong", capturedAt: 13 })).rejects.toThrow("hash does not match");
  });

  test("applies byte splices across multibyte text", async () => {
    const base = JSON.stringify({ text: "alpha λ omega" });
    const target = JSON.stringify({ text: "alpha λ and 日本語 omega" });
    const current = await updateDocument(null, { kind: "full", document: base, hash: hash(base), capturedAt: 20 });
    const splice = contextSplice(base, target);
    const changed = await updateDocument(current, { kind: "splice", hash: hash(target), capturedAt: 21, splice });
    expect(changed).toEqual({ document: target, hash: hash(target), capturedAt: 21 });
  });

  test("rejects a splice for a different base", async () => {
    const current = await updateDocument(null, { kind: "full", document: "one", hash: hash("one"), capturedAt: 1 });
    const splice = contextSplice("other", "target");
    await expect(updateDocument(current, { kind: "splice", hash: splice.targetHash, capturedAt: 2, splice })).rejects.toThrow("does not match its base");
  });
});
