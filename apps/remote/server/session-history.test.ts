import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HISTORY_MARKER, READ_THREAD_CONTRACT } from "../../../tools/read-condensed-session/contract.mjs";
import conversation from "./conversation";

test("history metadata derives from the reader contract and keeps the system prefix unchanged as the branch grows", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  let contractReads = 0;
  conversation({
    on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
    exec: async (command: string, args: string[], options: { timeout: number }) => {
      expect([command, ...args]).toEqual(["read-thread", "--contract"]);
      expect(options.timeout).toBe(20_000);
      contractReads++;
      return { code: 0, stdout: JSON.stringify(READ_THREAD_CONTRACT), stderr: "", killed: false };
    },
  } as unknown as ExtensionAPI);
  const prompts: string[] = [];
  const describe = async (file: string | undefined, leaf: string | null) => {
    const result = await handlers.get("before_agent_start")!(
      { systemPrompt: "Existing system" },
      { sessionManager: { getSessionFile: () => file, getLeafId: () => leaf } },
    );
    expect(result.systemPrompt).toStartWith("Existing system\n\n");
    prompts.push(result.systemPrompt);
    return JSON.parse(result.systemPrompt.slice("Existing system\n\n".length));
  };
  const { historyMarker, version, ...reader } = READ_THREAD_CONTRACT;
  const first = await describe("/sessions/one.jsonl", "one-leaf");
  expect(first).toEqual({ type: HISTORY_MARKER, version, sessionFile: "/sessions/one.jsonl", reader });
  expect(await describe("/sessions/one.jsonl", "later-leaf")).toEqual(first);
  expect(prompts[1]).toBe(prompts[0]);
  expect(await describe("/sessions/two.jsonl", "two-leaf")).toMatchObject({ sessionFile: "/sessions/two.jsonl" });
  expect(await describe(undefined, null)).toMatchObject({ sessionFile: null });
  expect(contractReads).toBe(1);
});

test("a failed command contract is reported and not retained as working metadata", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  let fail = true;
  conversation({
    on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
    exec: async () => fail
      ? { code: 1, stdout: "", stderr: "unsupported contract", killed: false }
      : { code: 0, stdout: JSON.stringify(READ_THREAD_CONTRACT), stderr: "", killed: false },
  } as unknown as ExtensionAPI);
  const describe = () => handlers.get("before_agent_start")!(
    { systemPrompt: "Existing system" },
    { sessionManager: { getSessionFile: () => undefined, getLeafId: () => null } },
  );
  await expect(describe()).rejects.toThrow("unsupported contract");
  fail = false;
  expect((await describe()).systemPrompt).toContain(HISTORY_MARKER);
});

test("a killed zero-exit contract probe reports its startup deadline and retains no contract", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  let killed = true;
  conversation({
    on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
    exec: async () => ({ code: 0, stdout: killed ? "" : JSON.stringify(READ_THREAD_CONTRACT), stderr: "", killed }),
  } as unknown as ExtensionAPI);
  const describe = (signal = new AbortController().signal) => handlers.get("before_agent_start")!(
    { systemPrompt: "Existing system" },
    { signal, sessionManager: { getSessionFile: () => undefined } },
  );
  await expect(describe()).rejects.toThrow("20-second startup deadline exceeded");
  await expect(describe(AbortSignal.abort())).rejects.toThrow("session cancelled");
  killed = false;
  expect((await describe()).systemPrompt).toContain(HISTORY_MARKER);
});
