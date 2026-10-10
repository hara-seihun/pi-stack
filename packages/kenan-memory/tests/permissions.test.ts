import { expect, test } from "bun:test";
import { memoryService } from "../src/service.js";
import { MemoryStore } from "../src/store.js";

test("authenticated journal credentials never bypass the unified grant decision", async () => {
  const store = new MemoryStore(":memory:");
  const server = memoryService({ store, enabled: () => true, auth: { supervisors: [{ person: "kenan", token: "credential" }] }, peerUid: () => undefined,
    authorize: () => ({ ok: false, error: { code: "denied", message: "No resource grant" } }) });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1/sessions`, { method: "POST", headers: { "x-kenan-memory-session": "credential", "content-type": "application/json" }, body: JSON.stringify({ threadId: "thread" }) });
    expect(response.status).toBe(403);
    expect(store.db.query("SELECT count(*) AS count FROM sessions").get()).toEqual({ count: 0 });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
});
