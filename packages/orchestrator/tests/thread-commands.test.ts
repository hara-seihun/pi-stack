import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { dispatch } from "../src/commands.js";
const endpoint = "http://127.0.0.1:19181/v1/scopes/work/thread-owner";
beforeEach(() => {
  for (const key of ["PI_THREAD_ID", "PI_THREAD_CAN_SPAWN", "PI_THREAD_API_URL", "PI_THREAD_TOKEN"]) vi.stubEnv(key, undefined);
  const tokenFile = join(process.env.HOME!, "core-cli-token"); writeFileSync(tokenFile, "fixture-token\n");
  vi.stubEnv("PI_CORE_URL", "http://127.0.0.1:19181"); vi.stubEnv("PI_CORE_SCOPE_ID", "work"); vi.stubEnv("PI_CORE_TOKEN_FILE", tokenFile);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = 0; });
function transport(responses: unknown[] = []) {
  const calls: { path: string; method: string; body: any; authorization: string | null }[] = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    calls.push({ path: new URL(String(input)).pathname, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined, authorization: new Headers(init?.headers).get("authorization") });
    return Response.json(responses.length ? responses.shift() : { ok: true, value: { id: `thread-${calls.length}` } });
  });
  return calls;
}
it("preserves an agent parent and uses its injected native capability without reading a core token", async () => {
  vi.stubEnv("PI_THREAD_ID", "caller"); vi.stubEnv("PI_THREAD_API_URL", "http://127.0.0.1:18790/v1/threads"); vi.stubEnv("PI_THREAD_TOKEN", "native-capability"); vi.stubEnv("PI_CORE_TOKEN_FILE", "/missing/token");
  const calls = transport(); await dispatch(["run", "--prompt", "bounded work"]);
  expect(calls[0]!.body).toMatchObject({ parentId: "caller", ephemeral: true });
  expect(calls[0]!.authorization).toBeNull();
  expect(vi.mocked(fetch).mock.calls[0]![0]).toBe("http://127.0.0.1:18790/v1/threads/spawn");
  expect(new Headers(vi.mocked(fetch).mock.calls[0]![1]?.headers).get("x-pi-thread-token")).toBe("native-capability");
  await expect(dispatch(["run", "--prompt", "work", "--parent", "another"])).rejects.toThrow("own thread");
  expect(calls).toHaveLength(1);
});
it.each([undefined, "caller"])("sends one pending message with sender %s", async senderId => {
  vi.stubEnv("PI_THREAD_ID", senderId);
  const calls = transport(); await dispatch(["send", "recipient", "--prompt", "work"]);
  expect(calls[0]!.body).toEqual({ requestId: expect.any(String), threadId: "recipient", text: "work", delivery: "pending", ...(senderId ? { senderId } : {}) });
  expect(vi.mocked(fetch).mock.calls[0]![0]).toBe(`${endpoint}/send`);
  expect(calls[0]!.authorization).toBe("Bearer fixture-token");
});
it("restricted boundaries cannot bypass the missing spawn tool with CLI run", async () => {
  vi.stubEnv("PI_THREAD_CAN_SPAWN", "0"); const calls = transport();
  await expect(dispatch(["run", "--prompt", "work"])).rejects.toThrow("does not grant agent creation"); expect(calls).toHaveLength(0);
});
it("spawns fresh forced threads without resolving server settings and sends the core bearer", async () => {
  const calls = transport(); await dispatch(["run", "--prompt", "do work", "--cwd", "/work", "--count", "2"]);
  expect(calls).toHaveLength(2);
  for (const call of calls) expect(call).toEqual({ path: "/v1/scopes/work/thread-owner/spawn", method: "POST", authorization: "Bearer fixture-token", body: { requestId: expect.any(String), message: "do work", cwd: "/work", admission: "force", ephemeral: false } });
  expect(calls[0]!.body.requestId).not.toBe(calls[1]!.body.requestId);
});
it.each([
  { caller: undefined, args: ["--parent", "parent", "--ephemeral"], ephemeral: true },
  { caller: "parent", args: ["--ephemeral=true"], ephemeral: true },
  { caller: "parent", args: ["--ephemeral=false"], ephemeral: false },
])("sends explicit ephemeral=$ephemeral with caller $caller", async ({ caller, args, ephemeral }) => {
  vi.stubEnv("PI_THREAD_ID", caller); const calls = transport(); await dispatch(["run", "--prompt", "work", ...args]);
  expect(calls).toHaveLength(1); expect(calls[0]!.body).toMatchObject({ parentId: "parent", ephemeral });
});
it("sends explicit model, thinking, speed and admission", async () => {
  const calls = transport(); await dispatch(["run", "--prompt", "work", "--model", "luna", "--thinking", "high", "--speed", "priority", "--background", "--parent", "parent"]);
  expect(calls[0]!.body).toMatchObject({ settings: { model: "luna", thinkingLevel: "high", speed: "priority" }, admission: "background", parentId: "parent" });
});
it("stops a failed batch and includes the original accepted IDs", async () => {
  const calls = transport([{ ok: true, value: { id: "accepted" } }, { ok: false, error: { code: "unavailable", message: "Paused" } }]);
  await dispatch(["run", "--prompt", "work", "--count", "3"]); expect(fetch).toHaveBeenCalledTimes(2); expect(process.exitCode).toBe(1);
  expect(calls[1]!.body.requestId).not.toBe(calls[0]!.body.requestId);
  expect(JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0]))).toEqual({ ok: false, error: { code: "unavailable", message: "Paused", retryable: false, requestId: calls[1]!.body.requestId }, threads: [{ id: "accepted" }] });
});
it("reports terminal send rejection with its submitted request identity", async () => {
  const calls = transport([{ ok: false, error: { code: "conflict", message: "Identity already used" } }]);
  await dispatch(["send", "recipient", "--prompt", "work"]); expect(calls).toHaveLength(1); expect(process.exitCode).toBe(1);
  expect(JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0]))).toEqual({ ok: false, error: { code: "conflict", message: "Identity already used", retryable: false, requestId: calls[0]!.body.requestId } });
});
it.each([
  { argv: ["read", "thread/id", "--cursor", "page", "--limit", "5"], operation: "read", body: { threadId: "thread/id", cursor: "page", limit: 5 } },
  { argv: ["list", "--parent", "parent", "--state", "idle", "--limit", "4"], operation: "list", body: { parentId: "parent", state: "idle", limit: 4 } },
  { argv: ["send", "thread/id", "--prompt", "new work"], operation: "send", body: { requestId: expect.any(String), threadId: "thread/id", text: "new work", delivery: "pending" } },
])("uses registered native thread $operation", async ({ argv, operation, body }) => {
  const calls = transport(); await dispatch(argv); expect(calls).toEqual([{ path: `/v1/scopes/work/thread-owner/${operation}`, method: "POST", body, authorization: "Bearer fixture-token" }]);
});
it.each([
  ["run", "--prompt", "work", "--count", "0"], ["run", "--prompt", "work", "--count", "1.5"],
  ["run", "--prompt", "work", "--profile", "standard"], ["run", "--prompt", "work", "--thinking", "invalid"], ["run", "--prompt", "work", "--ephemeral=invalid"],
  ...["queue", "steer", "hardSteer"].map(delivery => ["send", "thread", "--prompt", "work", "--delivery", delivery]),
  ["names", "--count", "2"], ["schedule", "create", "--prompt", "work"], ["wave", "review"], ["daemon"], ["worker", "run"], ["recover", "run"], ["abort", "run"], ["kill", "run"],
])("rejects unsupported input %j without transport", async (...argv) => {
  const calls = transport(); await expect(dispatch(argv)).rejects.toThrow(); expect(calls).toEqual([]);
});
it.each(["PI_CORE_SCOPE_ID", "PI_CORE_URL", "PI_CORE_TOKEN_FILE"])("refuses missing %s instead of choosing another owner", async key => {
  vi.stubEnv(key, undefined); const calls = transport();
  await expect(dispatch(["list"])).rejects.toThrow(key);
  expect(calls).toEqual([]);
});
