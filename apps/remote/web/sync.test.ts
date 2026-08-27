import { describe, expect, test } from "bun:test";
import { createHash, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { contextSplice } from "../server/sync";

function client() {
  const context: Record<string, any> = {
    atob: (value: string) => Buffer.from(value, "base64").toString("binary"),
    crypto: webcrypto,
    TextDecoder,
    TextEncoder,
  };
  context.globalThis = context;
  createContext(context);
  runInContext(readFileSync(join(import.meta.dir, "sync.js"), "utf8"), context, { filename: "sync.js" });
  return context.PiRemoteSync as { update(current: any, change: any): Promise<any> };
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

describe("browser resumable synchronization", () => {
  test("verifies full documents and clears them", async () => {
    const sync = client();
    const document = JSON.stringify({ messages: [{ content: "hello" }] });
    const current = await sync.update(null, { kind: "full", document, hash: hash(document), capturedAt: 12 });
    expect(current).toEqual({ document, hash: hash(document), capturedAt: 12 });
    expect(await sync.update(current, null)).toBe(current);
    expect(await sync.update(current, { kind: "clear" })).toBeNull();
    await expect(sync.update(null, { kind: "full", document, hash: "wrong", capturedAt: 13 })).rejects.toThrow("hash does not match");
  });

  test("applies byte splices across multibyte text", async () => {
    const sync = client();
    const base = JSON.stringify({ text: "alpha λ omega" });
    const target = JSON.stringify({ text: "alpha λ and 日本語 omega" });
    const current = await sync.update(null, { kind: "full", document: base, hash: hash(base), capturedAt: 20 });
    const splice = contextSplice(base, target);
    const changed = await sync.update(current, { kind: "splice", hash: hash(target), capturedAt: 21, splice });
    expect(changed).toEqual({ document: target, hash: hash(target), capturedAt: 21 });
  });

  test("rejects a splice for a different base", async () => {
    const sync = client();
    const base = "one";
    const current = await sync.update(null, { kind: "full", document: base, hash: hash(base), capturedAt: 1 });
    const splice = contextSplice("other", "target");
    await expect(sync.update(current, { kind: "splice", hash: splice.targetHash, capturedAt: 2, splice }))
      .rejects.toThrow("does not match its base");
  });
});
