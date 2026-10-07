import { expect, test } from "bun:test";
import { AppUpdater, APP_UPDATE_FRESHNESS_MS, APP_UPDATE_RETRY_MS, startAppUpdateChecks, type UpdatePort } from "./src/app-update-state";
import type { AppUpdateCheck, AppUpdateInstall } from "./src/native";
import { holdLiveMedia } from "./src/live-media";

const revision = "a".repeat(40);
function fixture(kind: "web" | "apk" = "web") {
  let next: AppUpdateCheck = { installed: {} as any, update: { kind, revision, versionCode: 10001, ready: false } };
  const remembered = new Set<string>();
  let checks = 0;
  let installs = 0;
  let install: () => Promise<AppUpdateInstall> = async () => ({ status: kind === "web" ? "reloading" : "installer-opened" });
  const port: UpdatePort = {
    check: async () => { checks++; return next; },
    install: () => { installs++; return install(); },
    attempted: value => remembered.has(value),
    remember: value => { remembered.add(value); },
  };
  return { port, updater: new AppUpdater(port), remembered, checks: () => checks, installs: () => installs,
    setCheck: (value: AppUpdateCheck) => { next = value; }, setInstall: (value: typeof install) => { install = value; } };
}

test("automatically applies a web update, coalescing checks and avoiding overlap during reload", async () => {
  const f = fixture();
  let finish!: (result: AppUpdateInstall) => void;
  f.setInstall(() => new Promise(resolve => { finish = resolve; }));
  const first = f.updater.check();
  const concurrent = f.updater.check();
  expect(concurrent).toBe(first);
  await Promise.resolve();
  expect(f.installs()).toBe(1);
  expect(f.updater.snapshot().busy).toBe(true);
  await f.updater.check();
  finish({ status: "reloading" });
  await first;
  await f.updater.check(true);
  expect(f.installs()).toBe(1);
  expect(f.updater.snapshot().status).toBe("Restarting…");
});

test("automatically opens each APK installer once, allows manual reopen, and restores Machine after installation", async () => {
  const f = fixture("apk");
  await f.updater.check();
  expect(f.installs()).toBe(1);
  expect(f.remembered.has(revision)).toBe(true);
  await f.updater.check();
  expect(f.installs()).toBe(1);
  const remounted = new AppUpdater(f.port);
  await remounted.check();
  expect(f.installs()).toBe(1);
  await remounted.check(true);
  expect(f.installs()).toBe(2);
  f.setCheck({ installed: {} as any, update: null });
  await remounted.check();
  expect(remounted.snapshot()).toMatchObject({ visible: false, busy: false, error: "", approval: false });
  f.setCheck({ installed: {} as any, update: { kind: "apk", revision: "b".repeat(40), versionCode: 10002, ready: false } });
  await remounted.check();
  expect(f.installs()).toBe(3);
});

test("a failed transfer remains visible and retries only on the next check", async () => {
  const f = fixture("apk");
  f.setInstall(async () => { throw new Error("Network disconnected"); });
  await f.updater.check();
  expect(f.installs()).toBe(1);
  expect(f.updater.snapshot()).toMatchObject({ visible: true, busy: false, error: "Network disconnected" });
  expect(f.remembered.size).toBe(0);
  f.setInstall(async () => ({ status: "installer-opened" }));
  await f.updater.check();
  expect(f.installs()).toBe(2);
  expect(f.updater.snapshot()).toMatchObject({ error: "", approval: true });
});

test("Android permission refusal does not automatically reopen settings", async () => {
  const f = fixture("apk");
  f.setInstall(async () => { throw new Error("Allow installs from Kenan in Android settings, then tap Update app again."); });
  await f.updater.check();
  await f.updater.check();
  expect(f.installs()).toBe(1);
  await f.updater.check(true);
  expect(f.installs()).toBe(2);
});

test("a failed check does not claim an available update or hide Machine; the next check recovers", async () => {
  const f = fixture();
  let fail = true;
  const check = f.port.check;
  f.port.check = async () => { if (fail) throw new Error("Offline"); return check(); };
  await f.updater.check();
  expect(f.updater.snapshot()).toMatchObject({ visible: false, error: "Update check failed. Offline" });
  expect(f.installs()).toBe(0);
  fail = false;
  await f.updater.check();
  expect(f.installs()).toBe(1);
  expect(f.updater.snapshot().error).toBe("");
});

test("automatic lifecycle checks share a five-minute freshness budget; manual retry bypasses it", async () => {
  const f = fixture("apk");
  f.setCheck({ installed: {} as any, update: null });
  let now = 1_000;
  const updater = new AppUpdater(f.port, () => now);
  await Promise.all([updater.checkFresh(), updater.checkFresh(), updater.checkFresh()]);
  expect(f.checks()).toBe(1);
  now += APP_UPDATE_FRESHNESS_MS - 1;
  await updater.checkFresh();
  expect(f.checks()).toBe(1);
  now++;
  await updater.checkFresh();
  expect(f.checks()).toBe(2);
  await updater.check(true);
  expect(f.checks()).toBe(3);
  expect(updater.freshnessDelay()).toBe(APP_UPDATE_FRESHNESS_MS);
});

test("failed automatic checks have an explicit retry budget instead of retrying every lifecycle event", async () => {
  let now = 0;
  let checks = 0;
  const f = fixture("apk");
  f.port.check = async () => { checks++; throw new Error("Offline"); };
  const updater = new AppUpdater(f.port, () => now);
  await updater.checkFresh();
  await updater.checkFresh();
  expect(checks).toBe(1);
  expect(updater.freshnessDelay()).toBe(APP_UPDATE_RETRY_MS);
  now += APP_UPDATE_RETRY_MS;
  await updater.checkFresh();
  expect(checks).toBe(2);
});

test("updates wait for every live media owner, then automatically resume on explicit close", async () => {
  const f = fixture();
  const closeMeeting = holdLiveMedia();
  const closeVoice = holdLiveMedia();
  const dispose = startAppUpdateChecks(f.updater, {
    visible: () => true,
    subscribe: () => () => {},
    schedule: () => () => {},
  });
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  try {
    await flush();
    expect(f.installs()).toBe(0);
    expect(f.updater.snapshot()).toMatchObject({ visible: true, busy: false, error: "" });
    await f.updater.check(true);
    expect(f.installs()).toBe(0);
    closeMeeting(); await flush();
    expect(f.installs()).toBe(0);
    closeVoice(); await flush();
    expect(f.installs()).toBe(1);
    expect(f.updater.snapshot().status).toBe("Restarting…");
  } finally { closeMeeting(); closeVoice(); dispose(); }
});

test("a call started during update discovery is held; an already-applying update refuses new capture", async () => {
  const f = fixture();
  const checked = f.port.check();
  let finish!: () => void;
  f.port.check = () => new Promise(resolve => { finish = async () => resolve(await checked); });
  const checking = f.updater.check();
  const close = holdLiveMedia();
  try {
    finish(); await checking;
    expect(f.installs()).toBe(0);
  } finally { close(); }
  let installed!: (value: AppUpdateInstall) => void;
  f.port.check = () => checked;
  f.setInstall(() => new Promise(resolve => { installed = resolve; }));
  const installing = f.updater.check();
  await Promise.resolve();
  expect(() => holdLiveMedia()).toThrow("An app update is applying");
  installed({ status: "reloading" }); await installing;
  const released = holdLiveMedia(); released();
});

test("update lifecycle owns one freshness timer, none while hidden, and resumes without an event storm", async () => {
  const f = fixture("apk");
  f.setCheck({ installed: {} as any, update: null });
  let now = 0;
  let visible = true;
  let changed: (() => void) | null = null;
  const timers = new Map<() => void, number>();
  const updater = new AppUpdater(f.port, () => now);
  const dispose = startAppUpdateChecks(updater, {
    visible: () => visible,
    subscribe: listener => { changed = listener; return () => { changed = null; }; },
    schedule: (listener, delay) => { timers.set(listener, delay); return () => { timers.delete(listener); }; },
  });
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  await flush();
  expect(f.checks()).toBe(1);
  expect([...timers.values()]).toEqual([APP_UPDATE_FRESHNESS_MS]);
  visible = false; changed!();
  expect(timers.size).toBe(0);
  now += 100;
  changed!(); await flush();
  expect(f.checks()).toBe(1);
  visible = true; changed!(); changed!(); changed!(); await flush();
  expect(f.checks()).toBe(1);
  expect([...timers.values()]).toEqual([APP_UPDATE_FRESHNESS_MS - 100]);
  now += APP_UPDATE_FRESHNESS_MS;
  changed!(); changed!(); await flush();
  expect(f.checks()).toBe(2);
  expect(timers.size).toBe(1);
  dispose();
  expect(timers.size).toBe(0);
  expect(changed).toBeNull();
});
