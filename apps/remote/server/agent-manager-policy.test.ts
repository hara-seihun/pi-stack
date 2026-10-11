import { expect, test } from "bun:test";
import { handleAgentManager } from "./agent-manager";
import type { Person } from "./persons";
const person: Person = { version: 1, user: "kenan", displayName: "Kenan", port: 18790, environment: { PI_REMOTE_MANAGER_ENVIRONMENT: "local" } };
const people = new Map([[1002, "kenan"]]);
const projected = { ok: true, value: { view: "mono", managerThreadId: "original-manager" } };
const request = (operation = "managerNotificationPolicy", input: unknown = {}) => new Request(`http://router/v1/agent-manager/${operation}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input, environmentId: "local" }) });
test("exact policy transport uses registered own UID without granting UI environments", async () => {
  let proxyCalls = 0, policyCalls: unknown[] = [];
  const result = await handleAgentManager(request(), { uid: 1002 }, people, () => person, () => [{ id: "converge", name: "Converge", baseUrl: "" }], "converge", async () => { proxyCalls++; return Response.json({}); }, async (...args) => { policyCalls.push(args.slice(0, 4)); return Response.json(projected); });
  expect(result.status).toBe(200); expect(await result.json()).toEqual(projected);
  expect(policyCalls).toEqual([["kenan", 1002, "converge", "local"]]); expect(proxyCalls).toBe(0); expect(person.remoteAccess).toBeUndefined(); expect(person.unlock).toBeUndefined();
});
test("other operations, payloads and unregistered identities never consume policy authority", async () => {
  let calls = 0;
  const invoke = (req: Request, uid: number) => handleAgentManager(req, { uid }, people, () => person, () => [], "converge", async () => Response.json({}), async () => { calls++; return Response.json(projected); });
  expect((await invoke(request("send", { threadId: "original-manager", text: "unauthorized" }), 1002)).status).toBe(503);
  expect((await invoke(request("managerNotificationPolicy", { extra: true }), 1002)).status).toBe(503);
  expect((await invoke(request(), 999)).status).toBe(403); expect(calls).toBe(0);
});

test("canonical notice delivery uses its separate enrollment without UI grants or policy authority", async () => {
  const input = { threadId: "original-manager", requestId: "manager-notice:fleet:settlement:original", senderId: "original-worker", source: "notification", text: "Original outcome" };
  let notices = 0, proxies = 0, policies = 0;
  const invoke = (uid: number, operation = "send") => handleAgentManager(request(operation, input), { uid }, people, () => person, () => [], "converge",
    async () => { proxies++; return Response.json({}); }, async () => { policies++; return Response.json(projected); },
    async (user, uid, source, target, original) => { notices++; expect([user, uid, source, target]).toEqual(["kenan", 1002, "converge", "local"]); expect(original).toEqual(input); return Response.json({ ok: true, value: { id: input.requestId, threadId: input.threadId } }); });
  expect((await invoke(1002)).status).toBe(200);
  expect((await invoke(999)).status).toBe(403);
  expect((await invoke(1002, "questionOrigin")).status).toBe(503);
  expect(notices).toBe(1); expect(proxies).toBe(0); expect(policies).toBe(0);
  expect(person.remoteAccess).toBeUndefined(); expect(person.unlock).toBeUndefined();
});
