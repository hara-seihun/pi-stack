import { AsyncLocalStorage } from "node:async_hooks";
import { expect, test, vi } from "vitest";
import { bindRunnerEnvironments, RunnerFutureFactory, RUNNER_FACTORY_PROTOCOL, type RunnerFactoryBinding, type RunnerFactoryIdentity } from "../src/threads/runner-factory.js";
import { requireOwnedFactoryStatus, requireRunnerControlRequest } from "../src/threads/runner-protocol.js";

function binding(name: string): RunnerFactoryBinding {
  const identity: RunnerFactoryIdentity = { entryPath: `/releases/${name}/dist/threads/pi-session.js`, entrySha256: name.repeat(64), sdkDirectory: `/dependencies/${name}`, sourceCommit: name.repeat(40) };
  return { identity, module: { runnerFactoryProtocol: RUNNER_FACTORY_PROTOCOL, runnerSdkDirectory: identity.sdkDirectory,
    piEnvironmentScope: new AsyncLocalStorage(), openPiSession: vi.fn(), runnerProjectionContinuity: () => true } };
}

test("upgrade atomically selects future opens while accepted adapter and its old environment remain unchanged", async () => {
  const old = binding("a"), next = binding("b"), lease = vi.fn();
  const load = vi.fn(async () => ({ ok: true as const, value: next }));
  const factory = new RunnerFutureFactory(old, lease, load);
  const resident = factory.snapshot();
  const env = { PI_THREAD_ID: "original", PI_SESSION_WRITER_DIRECTORY: "/registered/writers", PI_SESSION_WRITER_SCOPE: "registered-sdk-scope" };
  expect(await factory.upgrade(old.identity, next.identity)).toMatchObject({ ok: true, value: { previous: old.identity, current: next.identity } });
  expect(factory.snapshot()).toBe(next);
  expect(resident).toBe(old);
  expect(old.module.openPiSession).not.toHaveBeenCalled();
  const run = bindRunnerEnvironments([old.module.piEnvironmentScope, next.module.piEnvironmentScope], env, async () => {
    await Promise.resolve();
    expect(old.module.piEnvironmentScope.getStore()).toBe(env);
    expect(next.module.piEnvironmentScope.getStore()).toBe(env);
    expect(env.PI_SESSION_WRITER_SCOPE).toBe("registered-sdk-scope");
  });
  await run;
  expect(old.module.piEnvironmentScope.getStore()).toBeUndefined();
  expect(next.module.piEnvironmentScope.getStore()).toBeUndefined();
  expect(lease).toHaveBeenCalledTimes(2);
  expect(load).toHaveBeenCalledTimes(1);
});

test("failed preparation, stale predecessor, and lease loss never alter the current creator", async () => {
  const old = binding("a"), next = binding("b");
  const failed = new RunnerFutureFactory(old, () => {}, async () => ({ ok: false, error: { code: "factory-unavailable", message: "exact module unavailable" } }));
  expect(await failed.upgrade(old.identity, next.identity)).toMatchObject({ ok: false, error: { code: "factory-unavailable" } });
  expect(failed.snapshot()).toBe(old);
  const load = vi.fn(async () => ({ ok: true as const, value: next }));
  const stale = new RunnerFutureFactory(old, () => {}, load);
  expect(await stale.upgrade(next.identity, next.identity)).toMatchObject({ ok: false, error: { code: "factory-conflict" } });
  expect(load).not.toHaveBeenCalled();
  let owned = true;
  const lost = new RunnerFutureFactory(old, () => { if (!owned) throw new Error("physical lease changed"); }, async () => { owned = false; return { ok: true, value: next }; });
  expect(await lost.upgrade(old.identity, next.identity)).toMatchObject({ ok: false, error: { code: "ownership-conflict" } });
  expect(lost.snapshot()).toBe(old);
});

test("same-target stale and overlapping upgrades acknowledge selected custody without replacing residents", async () => {
  const old = binding("a"), next = binding("b"), other = binding("c");
  let releases: Array<() => void> = [], owned = true;
  const load = vi.fn(() => new Promise<{ ok: true; value: RunnerFactoryBinding }>(resolve => { releases.push(() => resolve({ ok: true, value: next })); }));
  const factory = new RunnerFutureFactory(old, () => { if (!owned) throw new Error("lease lost"); }, load), resident = factory.snapshot();
  const first = factory.upgrade(old.identity, next.identity), second = factory.upgrade(old.identity, next.identity);
  expect(load).toHaveBeenCalledTimes(2);
  releases[0]!(); expect(await first).toMatchObject({ ok: true, value: { previous: old.identity, current: next.identity } });
  releases[1]!(); expect(await second).toMatchObject({ ok: true, value: { previous: next.identity, current: next.identity } });
  expect(await factory.upgrade(old.identity, next.identity)).toMatchObject({ ok: true, value: { previous: next.identity, current: next.identity } });
  expect(load).toHaveBeenCalledTimes(2); expect(factory.snapshot()).toBe(next); expect(resident).toBe(old);
  expect(await factory.upgrade(old.identity, other.identity)).toMatchObject({ ok: false, error: { code: "factory-conflict" } });
  owned = false;
  expect(await factory.upgrade(old.identity, next.identity)).toMatchObject({ ok: false, error: { code: "ownership-conflict" } });
  expect(next.module.openPiSession).not.toHaveBeenCalled(); expect(old.module.openPiSession).not.toHaveBeenCalled();
});

test("different-target winner and lease loss during same-target preparation remain conflicts", async () => {
  const old = binding("a"), next = binding("b"), other = binding("c");
  let release!: () => void, owned = true;
  const load = vi.fn((identity: RunnerFactoryIdentity) => identity === next.identity
    ? new Promise<{ ok: true; value: RunnerFactoryBinding }>(resolve => { release = () => resolve({ ok: true, value: next }); })
    : Promise.resolve({ ok: true as const, value: other }));
  const factory = new RunnerFutureFactory(old, () => { if (!owned) throw new Error("lease lost"); }, load);
  const pending = factory.upgrade(old.identity, next.identity);
  expect(await factory.upgrade(old.identity, other.identity)).toMatchObject({ ok: true });
  release(); expect(await pending).toMatchObject({ ok: false, error: { code: "factory-conflict" } });
  expect(factory.snapshot()).toBe(other);
  const same = new RunnerFutureFactory(old, () => { if (!owned) throw new Error("lease lost"); }, load);
  const waiting = same.upgrade(old.identity, next.identity);
  owned = false; release();
  expect(await waiting).toMatchObject({ ok: false, error: { code: "ownership-conflict" } });
  expect(same.snapshot()).toBe(old);
});

test("same-candidate status requires every exact owner field and the responding process", () => {
  const owner = { version: 1 as const, dataDir: "/data", uid: 1000, control: "/control", pid: 12, startTicks: "42" };
  const status = { ok: true, factoryProtocol: RUNNER_FACTORY_PROTOCOL, futureFactory: binding("b").identity, pid: owner.pid, nativeOwner: owner };
  expect(requireOwnedFactoryStatus(status, owner)).toEqual(status);
  for (const changed of [{ uid: 1001 }, { dataDir: "/other" }, { control: "/other" }, { pid: 13 }, { startTicks: "43" }]) {
    expect(() => requireOwnedFactoryStatus({ ...status, nativeOwner: { ...owner, ...changed } }, owner)).toThrow("different process/storage owner");
  }
  expect(() => requireOwnedFactoryStatus({ ...status, pid: 13 }, owner)).toThrow("different process/storage owner");
  expect(() => requireOwnedFactoryStatus({ ...status, nativeOwner: undefined }, owner)).toThrow("lacks exact process/storage ownership");
});

test("upgrade wire rejects missing exact identity and has no implicit protocol selection", () => {
  const request = { type: "upgrade_factory", protocol: RUNNER_FACTORY_PROTOCOL, owner: { version: 1, dataDir: "/data", uid: 1000, control: "/control", pid: 1, startTicks: "42" }, expected: binding("a").identity, candidate: binding("b").identity };
  expect(requireRunnerControlRequest(request)).toEqual(request);
  expect(() => requireRunnerControlRequest({ ...request, protocol: undefined })).toThrow();
  expect(() => requireRunnerControlRequest({ ...request, candidate: { ...request.candidate, entrySha256: undefined } })).toThrow();
});
