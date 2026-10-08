import { expect, test } from "bun:test";
import { contextResponse, type ReadRawContext } from "./context-response";

const request = (etag?: string) => new Request("http://remote.test/v1/sessions/s/context", { headers: etag ? { "if-none-match": etag } : {} });
function fixture(count: number) {
  const entries = Array.from({ length: count }, (_, index) => ({ type: index === 3 ? "compaction" : "message", id: `native:${index}`,
    parentId: index ? `native:${index - 1}` : null, timestamp: index + 1, message: { role: "user", timestamp: index + 1, content: `Native record ${index} 日本 🌙` } }));
  const calls: Array<{ after: number | undefined; limit: number; revision: string | undefined }> = [];
  let failure: { code: string; message: string } | undefined;
  const read: ReadRawContext = async (after, limit, revision) => {
    calls.push({ after, limit, revision });
    if (failure && after !== undefined) return { ok: false, error: failure };
    const from = after === undefined ? 0 : after + 1;
    return { ok: true, value: { source: { revision: "r", kind: "native-jsonl", leafId: entries.at(-1)?.id ?? null }, total: entries.length,
      records: entries.slice(from, from + limit).map((entry, offset) => ({ index: from + offset, entryId: entry.id, message: entry.message, entry })) } };
  };
  return { entries, read, calls, fail: (value: typeof failure) => { failure = value; } };
}

test("history exports native entries including compaction and exact identity through bounded pinned pages", async () => {
  const native = fixture(73);
  const response = await contextResponse({ id: "s" }, request(), native.read, { "x-fixture": "kept" });
  expect(response.headers.get("x-fixture")).toBe("kept");
  expect(response.headers.get("etag")).toBe('"r"');
  expect(await response.json()).toEqual({ source: { revision: "r", kind: "native-jsonl", leafId: "native:72" }, entries: native.entries, hash: "r", session: { id: "s" } });
  expect(native.calls).toEqual([
    { after: undefined, limit: 32, revision: undefined }, { after: 31, limit: 32, revision: "r" }, { after: 63, limit: 32, revision: "r" },
  ]);
});

test("empty history and conditional GET are native states, not missing capture fallbacks", async () => {
  const native = fixture(0);
  expect((await (await contextResponse(null, request(), native.read, {})).json()).entries).toEqual([]);
  const conditional = await contextResponse(null, request('"r"'), native.read, {});
  expect(conditional.status).toBe(304);
  expect(await conditional.text()).toBe("");
  expect(native.calls).toHaveLength(2);
});

test("source failure before or during a stream remains explicit", async () => {
  const fail: ReadRawContext = async () => ({ ok: false, error: { code: "oversized", message: "Native record exceeds its byte limit" } });
  const response = await contextResponse(null, request(), fail, {});
  expect(response.status).toBe(422);
  expect(await response.json()).toEqual({ code: "oversized", error: "Native record exceeds its byte limit" });
  const native = fixture(40);
  native.fail({ code: "stale_source", message: "Native branch changed" });
  const streaming = await contextResponse(null, request(), native.read, {});
  await expect(streaming.text()).rejects.toThrow("stale_source: Native branch changed");
});
