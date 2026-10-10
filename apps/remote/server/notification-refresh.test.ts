import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function harness(owners: string[]) {
  const rounds: Array<{ owner: string; work: ReturnType<typeof deferred> }> = [];
  const feedback: Array<{ owner: string; message: string | null }> = [];
  const source = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
  const start = source.indexOf("const notificationRefreshes =");
  const end = source.indexOf("async function refreshPeers()", start);
  if (start < 0 || end < 0) throw new Error("Notification refresh owner was not found");
  const program = new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(start, end) + "\nreturn refreshThreadNotifications;");
  const refresh = new Function("directory", "db", "projectThreadNotifications", "notificationFeedback", "notificationErrors", "signalSync", "pushNotifications", program)(
    { owners: owners.map(id => ({ id, api: {} })), managerNotificationPolicy: () => ({ ok: true, value: { view: "classic" } }) }, {},
    (_db: unknown, owner: string) => { const work = deferred(); rounds.push({ owner, work }); return work.promise; },
    (owner: string, message: string | null) => feedback.push({ owner, message }),
    new Map(), () => {}, () => {},
  ) as (cause?: "read" | "change") => Promise<void>;
  return { refresh, rounds, feedback };
}

test("read-only request bursts join one owner projection and a later read starts fresh", async () => {
  const { refresh, rounds } = harness(["person"]);
  const first = refresh("read");
  const readers = Array.from({ length: 20 }, () => refresh("read"));
  await tick();
  expect(rounds).toHaveLength(1);
  rounds[0]!.work.resolve(); await tick();
  expect(rounds).toHaveLength(1);
  await Promise.all([first, ...readers]);
  expect(rounds).toHaveLength(1);
  const later = refresh("read");
  await tick();
  expect(rounds).toHaveLength(2);
  rounds[1]!.work.resolve(); await later;
});

test("real events during projection request catchup; readers during catchup do not", async () => {
  const { refresh, rounds } = harness(["person"]);
  const first = refresh("read");
  const events = Array.from({ length: 10 }, () => refresh("change"));
  await tick();
  rounds[0]!.work.resolve();
  await tick();
  expect(rounds).toHaveLength(2);
  const readers = Array.from({ length: 10 }, () => refresh("read"));
  const nextEvent = refresh("change");
  await tick();
  rounds[1]!.work.resolve(); await tick();
  expect(rounds).toHaveLength(3);
  const lastReader = refresh("read");
  await tick();
  rounds[2]!.work.resolve(); await tick();
  expect(rounds).toHaveLength(3);
  await Promise.all([first, ...events, ...readers, nextEvent, lastReader]);
  expect(rounds).toHaveLength(3);
});

test("owners project independently and failed refresh keeps feedback and permits retry", async () => {
  const { refresh, rounds, feedback } = harness(["person", "fleet"]);
  const first = refresh("read");
  const joiner = refresh("read");
  await tick();
  expect(rounds.map(round => round.owner)).toEqual(["person", "fleet"]);
  rounds[0]!.work.reject(new Error("Owner unavailable"));
  rounds[1]!.work.resolve(); await tick();
  expect(rounds).toHaveLength(2);
  await Promise.all([first, joiner]);
  expect(feedback).toContainEqual({ owner: "person", message: "Owner unavailable" });
  const retry = refresh("read");
  await tick();
  expect(rounds.map(round => round.owner)).toEqual(["person", "fleet", "person", "fleet"]);
  rounds[2]!.work.resolve(); rounds[3]!.work.resolve(); await retry;
  expect(feedback.at(-2)).toEqual({ owner: "person", message: null });
});
