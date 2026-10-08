import { expect, test } from "bun:test";
import { readRecentHistoryMessages } from "./recent-history-messages";
import { validateInspectOptions } from "../../../packages/orchestrator/src/threads/contracts";

const text = (content: unknown) => typeof content === "string" ? content : "";

test("Voice reads native tail pages with one revision and excludes tools without starting a runtime", async () => {
  const calls: any[] = [];
  const inspect: any = async (id: string, options: any) => {
    calls.push([id, options]);
    expect(validateInspectOptions(options).ok).toBe(true);
    return { ok: true, value: { contextRecords: { source: { revision: "r" }, total: 65,
      records: options.contextRecords.before === Number.MAX_SAFE_INTEGER
        ? [{ index: 64, entryId: "tool", message: { role: "toolResult", content: "not conversation" } }]
        : [{ index: 0, entryId: "user", message: { role: "user", content: "Question" } },
          { index: 1, entryId: "reply", message: { role: "assistant", content: "Reply" } }] } } };
  };
  expect(await readRecentHistoryMessages(inspect, "s", 2, text)).toEqual({ ok: true, value: [{ role: "user", text: "Question" }, { role: "assistant", text: "Reply" }] });
  expect(calls).toEqual([["s", { contextRecords: { before: Number.MAX_SAFE_INTEGER, limit: 32 } }],
    ["s", { contextRecords: { before: 64, limit: 32, revision: "r" } }]]);
});

test("recent Voice reads are finite and source failures remain explicit", async () => {
  let reads = 0;
  const toolsOnly: any = async () => ({ ok: true, value: { contextRecords: { source: { revision: "r" }, total: 1000,
    records: [{ index: 900 - reads++ * 64, entryId: "tool", message: { role: "toolResult", content: "output" } }] } } });
  expect(await readRecentHistoryMessages(toolsOnly, "s", 8, text)).toEqual({ ok: true, value: [] });
  expect(reads).toBe(4);
  const failure = { ok: false as const, error: { code: "stale_source", message: "Native history changed" } };
  expect(await readRecentHistoryMessages(async () => failure as any, "s", 8, text)).toEqual(failure);
  expect(await readRecentHistoryMessages(toolsOnly, "s", 65, text)).toMatchObject({ ok: false, error: { code: "invalid_request" } });
});
