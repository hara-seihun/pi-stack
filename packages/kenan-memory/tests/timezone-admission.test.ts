import { expect, test } from "bun:test";
import { MemoryStore } from "../src/store.js";
import { memoryService } from "../src/service.js";
import { fixtureAuthorization } from "./authorization.js";

test("root timezone follows only the token-verified asking person and refreshes on queued resume", async () => {
  const store = new MemoryStore(":memory:"), alice = store.session("alice", "thread-a");
  const zone = { zone: "Europe/London", source: "configured" as const, observedAt: "2026-10-08T00:00:00Z" };
  const resolved: string[] = [];
  let unavailable = false;
  const server = memoryService({ authorize: fixtureAuthorization, store, auth: { supervisors: [{ person: "alice", token: "alice-supervisor" }], rootToken: "root-service" }, enabled: () => true, peerUid: () => undefined,
    timezone: person => { resolved.push(person); return unavailable ? { ok: false, error: { code: "unavailable", message: "projection missing" } } : { ok: true, value: zone }; } });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (route: string, body: unknown) => fetch(url + route, { method: "POST", headers: { "x-kenan-memory-session": "root-service" }, body: JSON.stringify(body) });
  try {
    const rejected = await post("/v1/root/admit", { callerToken: alice.token, request: "ask", timezone: { zone: "Asia/Tokyo" } });
    expect(rejected.status).toBe(400); expect(resolved).toHaveLength(0);
    const result = await (await post("/v1/root/admit", { callerToken: alice.token, request: "ask about Bob" })).json();
    expect(result.value.person).toBe("alice"); expect(result.value.timezone).toEqual(zone); expect(resolved).toEqual(["alice"]);
    zone.zone = "America/New_York";
    const resumed = await (await post("/v1/root/resume-request", { rootSessionId: result.value.rootSessionId })).json();
    expect(resumed.value.timezone.zone).toBe("America/New_York"); expect(resolved).toEqual(["alice", "alice"]);
    unavailable = true;
    const refused = await post("/v1/root/admit", { callerToken: alice.token, request: "ask again" });
    expect(refused.status).toBe(503);
    expect(store.db.query("SELECT count(*) AS n FROM root_runs").get()).toEqual({ n: 1 });
    const consent = { rootSessionId: result.value.rootSessionId, subject: "alice", consentId: "consent-1" };
    expect((await post("/v1/root/log-consent", { ...consent, kind: "question", text: "Share this?" })).status).toBe(200);
    expect((await post("/v1/root/log-consent", { ...consent, kind: "answer", text: "Yes" })).status).toBe(200);
    const input = { ...consent, question: "Share this?", answer: "Yes" };
    expect((await post("/v1/root/resume-consent", input)).status).toBe(503);
    expect(store.db.query("SELECT count(*) AS n FROM consent_resumes").get()).toEqual({ n: 0 });
    expect(store.db.query("SELECT count(*) AS n FROM root_runs").get()).toEqual({ n: 1 });
    unavailable = false;
    const consentResume = await (await post("/v1/root/resume-consent", input)).json();
    expect(consentResume.value.timezone.zone).toBe("America/New_York");
    expect(consentResume.value.person).toBe("alice");
    expect(store.db.query("SELECT count(*) AS n FROM consent_resumes").get()).toEqual({ n: 1 });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
});
