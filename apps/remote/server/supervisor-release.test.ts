import { expect, test } from "bun:test";
import type { Result } from "pi-orchestrator/api";
import { SupervisorRelease } from "./supervisor-release";

const ok: Result<void> = { ok: true, value: undefined };

test("release closes resources after native runner detachment without a context upload handshake", async () => {
  const events: string[] = [];
  let finish!: (value: Result<void>) => void;
  const detached = new Promise<Result<void>>(resolve => { finish = resolve; });
  const release = new SupervisorRelease({ suspend() { events.push("suspend"); }, detach: () => detached,
    closeImages: async () => { events.push("images"); }, stopServer() { events.push("server"); },
    closeDatabase() { events.push("database"); }, exit(code) { events.push(`exit:${code}`); } });
  const pending = release.release(75);
  expect(release.release(75)).toBe(pending);
  for (const method of ["POST", "PUT", "PATCH"]) expect(release.accepts(method, "/v1/sessions/thread/context")).toBe(false);
  finish(ok);
  expect(await pending).toEqual(ok);
  expect(events).toEqual(["suspend", "images", "server", "database", "exit:75"]);
  expect(await release.release(75)).toEqual(ok);
  expect(events.filter(event => event.startsWith("exit"))).toHaveLength(1);
});

test("failed detach preserves resources for an explicit retry", async () => {
  let failed = true;
  const events: string[] = [];
  const release = new SupervisorRelease({ suspend() { events.push("suspend"); },
    async detach() { return failed ? { ok: false, error: { code: "unavailable", message: "Runner close failed" } } : ok; },
    async closeImages() {}, stopServer() { events.push("server"); }, closeDatabase() { events.push("database"); }, exit() {} });
  expect((await release.release(75)).ok).toBe(false);
  expect(events).toEqual(["suspend"]);
  failed = false;
  expect(await release.release(75)).toEqual(ok);
  expect(events).toEqual(["suspend", "server", "database"]);
});
