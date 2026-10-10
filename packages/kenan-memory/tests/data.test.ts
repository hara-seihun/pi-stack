import { expect, test } from "bun:test";
import { memoryService } from "../src/service.js";
import { MemoryStore } from "../src/store.js";
import { fixtureAuthorization } from "./authorization.js";
test("generic data validates authentication/context/grants before dispatch and retains actual read subjects", async () => {
  const store = new MemoryStore(":memory:"), admission = store.admitRoot("alice", "requester", ["alice"], []);
  let denied = false, calls = 0;
  const server = memoryService({ store, enabled: () => true, auth: { supervisors: [] }, peerUid: () => undefined,
    authorize: request => denied ? { ok: false, error: { code: "denied", message: "No mapped execute grant" } } : fixtureAuthorization(request),
    data: async ({ caller, request }) => { calls++; expect(caller.kind).toBe("person"); return { ok: true, value: { value: { dataset: request.dataset, data: { events: [] } }, subjects: ["bob"], obviouslyPrivate: true } }; } });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const send = (body: unknown) => fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1/memory`, { method: "POST", headers: { "x-kenan-memory-session": admission.memoryToken, "content-type": "application/json" }, body: JSON.stringify(body) });
    const input = { operation: "data", dataset: "bob-calendar", requestId: "fixture", command: { operation: "records" }, context: { threadId: admission.rootSessionId, turnId: "turn" } };
    expect((await send({ ...input, context: { ...input.context, threadId: "other" } })).status).toBe(403); expect(calls).toBe(0);
    denied = true; expect((await send(input)).status).toBe(403); expect(calls).toBe(0);
    denied = false;
    const result = await (await send(input)).json() as any;
    expect(result.value.readReport.about).toEqual(["bob"]);
    expect(result.value.value.dataset).toBe("bob-calendar");
    expect(store.authorizationSubjects(admission.rootSessionId)).toContain("bob");
    expect(calls).toBe(1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
});
