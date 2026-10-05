import { expect, test } from "bun:test";
import { AppUpdater, type UpdatePort } from "./src/app-update-state";
import type { AppUpdateCheck, AppUpdateInstall } from "./src/native";

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
