import { expect, test } from "bun:test";
import { MemoryStore } from "../src/store.js";
import { memoryService } from "../src/service.js";
import { fixtureAuthorization } from "./authorization.js";

test("old requester-attributed captures stay private; identified public recipient actions remain readable", () => {
  const store = new MemoryStore(":memory:");
  try {
    const admission = store.admitRoot("alice", "requester", ["alice"], []);
    const input = { text: "Private root capture", about: ["alice"], obviouslyPrivate: true, source: { saidBy: "alice" }, setting: { person: "alice", threadId: admission.rootSessionId } };
    const capture = store.write("alice", input);
    const action = store.write("alice", { ...input, text: "Public delivered receipt", obviouslyPrivate: false, source: { actedFor: "alice", action: "message.send", externalId: "provider-receipt" } });
    const context = { threadId: "ordinary", turnId: "turn" };
    expect(store.read("alice", context, [capture.id, action.id], "person").value.map(item => item.id)).toEqual([action.id]);
    expect(store.search("alice", context, "", undefined, 10, "person").value.map(item => item.id)).toEqual([action.id]);
    expect(store.canForget("alice", [capture.id])).toBe(false);
    expect(store.read("alice", context, [capture.id], "root").value).toHaveLength(1);
    expect(store.authorizationItems([capture.id])[0]?.recordedBy).toBe("alice");
  } finally { store.close(); }
});

test("new admitted captures record actual service custody rather than pretending the requester authored them", async () => {
  const store = new MemoryStore(":memory:"), admission = store.admitRoot("alice", "requester", ["alice"], []);
  const server = memoryService({ store, enabled: () => true, auth: { supervisors: [] }, peerUid: () => undefined, authorize: fixtureAuthorization });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1/memory`, { method: "POST", headers: { "x-kenan-memory-session": admission.memoryToken, "content-type": "application/json" }, body: JSON.stringify({ operation: "write", item: { text: "Private capture", about: ["alice"], obviouslyPrivate: true, source: { saidBy: "alice" }, setting: { person: "alice", threadId: admission.rootSessionId } } }) });
    expect(response.status).toBe(200);
    const result = await response.json() as any;
    expect(result.value.recordedBy).toBe("fixture");
    expect(store.read("alice", { threadId: "ordinary", turnId: "turn" }, [result.value.id], "person").value).toEqual([]);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
});
