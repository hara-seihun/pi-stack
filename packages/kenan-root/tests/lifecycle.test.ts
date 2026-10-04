import { expect, test } from "bun:test";
import { rootService, type RootReleaseState } from "../src/service.js";

const capability = "a".repeat(64);
function request(method: string, path = "/v1/admin/release", authenticated = true) {
  return new Request(`http://root${path}`, { method, headers: authenticated ? { "x-pi-kenan-admin": capability } : {} });
}
test("root release admission is authenticated, atomic with asks, and fences consent reconciliation", async () => {
  const state: RootReleaseState = { quiescing: false, consentActive: false };
  let finish: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const executing = new Promise<void>(resolve => entered = resolve);
  const wait = new Promise<void>(resolve => finish = resolve);
  let admissions = 0;
  const handle = rootService({ enabled: () => true, memoryUrl: "http://memory", memoryRootToken: "secret", adminCapability: capability, sessionsDir: "/unused",
    releaseCommit: "fixture-commit", releaseState: state, report() {},
    executor: async () => { entered!(); await wait; return { ok: true, value: { reply: "Chosen reply", subjects: [] } }; },
    transport: (async input => {
      if (String(input).endsWith("admit")) { admissions++; return Response.json({ ok: true, value: { rootSessionId: "private-id", recipients: [] } }); }
      return Response.json({ ok: true });
    }) as typeof fetch });
  expect(await (await handle(request("GET", "/v1/health", false))).json()).toEqual({ ok: true, service: "kenan-root", releaseCommit: "fixture-commit", releaseProtocol: 1 });
  expect((await handle(request("POST", undefined, false))).status).toBe(404);
  const ask = () => handle(new Request("http://root/v1/ask", { method: "POST", headers: { "x-kenan-memory-session": "person-token" }, body: '{"request":"fixture"}' }));
  const pending = ask(); await executing;
  expect((await handle(request("POST"))).status).toBe(409);
  expect(state.quiescing).toBe(false);
  finish!(); expect((await pending).status).toBe(200);
  state.consentActive = true;
  expect((await handle(request("POST"))).status).toBe(409);
  state.consentActive = false;
  expect((await handle(request("POST"))).status).toBe(200);
  expect(state.quiescing).toBe(true);
  expect((await ask()).status).toBe(503);
  expect(admissions).toBe(1);
  expect((await handle(request("DELETE"))).status).toBe(200);
  expect(state.quiescing).toBe(false);
  expect((await ask()).status).toBe(200);
  expect((await handle(request("DELETE"))).status).toBe(200);
});
