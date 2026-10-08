import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
function section(begin: string, end: string) {
  const start = source.indexOf(begin);
  const finish = source.indexOf(end, start);
  expect(start).toBeGreaterThan(-1);
  expect(finish).toBeGreaterThan(start);
  return source.slice(start, finish);
}

test("handoff cancels every queued projection before either database closes", () => {
  const timers = new Map<number, () => void>();
  const queued: (() => void)[] = [];
  let sequence = 0;
  let databaseOpen = true;
  let reads = 0;
  const schedule = (callback: () => void) => {
    const id = ++sequence;
    timers.set(id, callback);
    queued.push(callback);
    return id;
  };
  const read = () => { expect(databaseOpen).toBe(true); reads++; };
  const program = new Bun.Transpiler({ loader: "ts" }).transformSync(`
    let shuttingDown = false;
    const db = {};
    const refreshState = read;
    const pushLive = read;
    const removeEventJournal = () => { read(); return "pending"; };
    ${section("const STATE_COALESCE_MS =", "// The Machine screen")}
    ${section("const LIVE_SYNC_INTERVAL_MS =", "function sourceValue<T>")}
    ${section("const journalRemoval =", "// A rejected promise")}
    const modelAvailability = { path: "policy" };
    const unwatchFile = () => {};
    const watchList = { stop() {} };
    const stopAutoArchive = () => {};
    const uploadPruner = setInterval(read, 60000);
    const dashboardTicker = setInterval(read, 10000);
    const stopThreadRefresh = () => {};
    const transcriptTimers = new Map([["thread", setTimeout(read, 25)]]);
    const streams = new Map();
    const closeStream = () => {};
    const stopLedgerSnapshots = () => {};
    ${section("function stopSupervisorTimers()", "async function closeImageGeneration")}
    stateSyncPhase = "ready";
    signalSync();
    signalLiveSync();
    signalLiveSync();
    shuttingDown = true;
    stopSupervisorTimers();
    return { signalSync, signalLiveSync,
      pending: () => [statePushTimer, liveSyncTimer, stateSyncPending, liveSyncPending],
      stop: stopSupervisorTimers };
  `);
  const run = new Function("setTimeout", "setInterval", "clearTimeout", "clearInterval", "read", program);
  const harness = run(schedule, schedule, (id: number) => timers.delete(id), (id: number) => timers.delete(id), read);
  expect(reads).toBe(1);
  expect(timers.size).toBe(0);
  expect(harness.pending()).toEqual([null, null, false, false]);
  databaseOpen = false;
  // A callback already delivered by the event loop must also be harmless.
  for (const callback of queued.slice(0, 1).concat(queued.slice(4))) callback();
  harness.signalSync();
  harness.signalLiveSync();
  harness.stop();
  expect(reads).toBe(1);
  expect(timers.size).toBe(0);
  expect(harness.pending()).toEqual([null, null, false, false]);
});
