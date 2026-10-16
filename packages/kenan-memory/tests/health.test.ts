import { expect, test } from "bun:test";
import { memoryService } from "../src/service.js";
import { fixtureAuthorization } from "./authorization.js";
import { MemoryStore } from "../src/store.js";

test("memory health identifies the running immutable release without touching records or authentication", async () => {
  const store = new MemoryStore(":memory:");
  const server = memoryService({ authorize: fixtureAuthorization, store, auth: { supervisors: [] }, enabled: () => true, releaseCommit: "fixture-commit", peerUid: () => { throw new Error("Health must not resolve person"); } });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "kenan-memory", releaseCommit: "fixture-commit" });
    expect(store.db.query("SELECT count(*) AS count FROM sessions").get()).toEqual({ count: 0 });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
});
