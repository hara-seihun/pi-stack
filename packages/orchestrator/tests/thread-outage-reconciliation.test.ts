import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Check } from "typebox/value";
import { ThreadService } from "../src/threads/service.js";
import { createThreadClient, threadHttp } from "../src/threads/http.js";
import { threadTools } from "../src/threads/pi-tools.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "thread-outage-"));
  const options = { capacity: { mode: "unmanaged" as const }, databasePath: join(root, "threads.sqlite"), sessionsDir: root,
    openSession: async () => { throw new Error("Acceptance proof never opens native"); } };
  let owner = new ThreadService(options);
  cleanup.push(async () => { await owner.detach(); rmSync(root, { recursive: true, force: true }); });
  for (const id of ["sender", "recipient", "other"]) expect(await owner.spawn({ requestId: `create:${id}`, id, title: id, cwd: root })).toMatchObject({ ok: true });
  let healthy = false, accepted = false;
  const bodies: string[] = [];
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    bodies.push(String(init?.body));
    if (accepted && !healthy) throw new TypeError("Core port absent");
    const response = (await threadHttp(owner, new Request(url, init)))!;
    if (!healthy) {
      expect(await response.clone().json()).toMatchObject({ ok: true });
      accepted = true;
      await owner.detach();
      owner = new ThreadService(options);
      throw new TypeError("Core disappeared after durable acceptance");
    }
    return response;
  });
  const api = createThreadClient("http://owner/v1/threads", fetcher, { timeoutMs: 20 });
  const tools = threadTools({ threadId: "sender", cwd: root, sessionFile: join(root, "sender.jsonl"), args: [], env: {}, threads: api });
  return { get owner() { return owner; }, tools, bodies, fetcher, restore() { healthy = true; } };
}

it("a later tool call reconciles lost send acceptance using the original ID, never creating another message", async () => {
  const f = await fixture(), tool = f.tools.find(tool => tool.name === "thread_send")!;
  const input = { threadId: "recipient", text: "original instruction" };
  const first = await tool.execute("original", input, undefined, undefined, {} as never);
  expect(first.details).toMatchObject({ ok: false, error: { requestId: "sender:original", retryable: false } });
  f.restore();
  const recovery = { ...input, requestId: "sender:original" };
  expect(Check(tool.parameters, recovery)).toBe(true);
  const recovered = await tool.execute("different-tool-call", recovery, undefined, undefined, {} as never);
  expect(recovered.details).toMatchObject({ ok: true, value: { id: "sender:original", state: "queued" } });
  expect(f.owner.pending("recipient")).toHaveLength(1);
  for (const body of f.bodies) expect(JSON.parse(body)).toEqual(JSON.parse(f.bodies[0]));
  for (const changed of [{ ...recovery, text: "different" }, { ...recovery, threadId: "other" }])
    expect((await tool.execute("changed", changed, undefined, undefined, {} as never)).details).toMatchObject({ ok: false, error: { code: "conflict" } });
  const calls = f.fetcher.mock.calls.length;
  expect((await tool.execute("foreign", { ...input, requestId: "another-caller:original" }, undefined, undefined, {} as never)).details).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  expect(f.fetcher).toHaveBeenCalledTimes(calls);
  expect(f.owner.pending("other")).toHaveLength(0);
});

it("wait recovery reuses its original durable registration after the request budget expires", async () => {
  const f = await fixture(), tool = f.tools.find(tool => tool.name === "thread_wait")!;
  const input = { action: "set" as const, kind: "message" as const, fromThreadId: "recipient" };
  expect((await tool.execute("original-wait", input, undefined, undefined, {} as never)).details).toMatchObject({ ok: false, error: { requestId: "sender:original-wait" } });
  f.restore();
  const recovery = { ...input, requestId: "sender:original-wait" };
  expect(Check(tool.parameters, recovery)).toBe(true);
  const recovered = await tool.execute("new-call", recovery, undefined, undefined, {} as never);
  expect(recovered.details).toMatchObject({ ok: true, value: { status: "registered" } });
  expect(recovered).toMatchObject({ terminate: true });
  for (const body of f.bodies) expect(JSON.parse(body)).toEqual(JSON.parse(f.bodies[0]));
  const since = f.owner.get("sender")?.metadata?.agentWait?.since;
  expect((await tool.execute("altered", { ...recovery, fromThreadId: "other" }, undefined, undefined, {} as never)).details).toMatchObject({ ok: false, error: { code: "conflict" } });
  expect(f.owner.get("sender")?.metadata?.agentWait?.since).toBe(since);
  expect((await tool.execute("foreign", { ...recovery, requestId: "recipient:original-wait" }, undefined, undefined, {} as never)).details).toMatchObject({ ok: false, error: { code: "invalid_request" } });
});
