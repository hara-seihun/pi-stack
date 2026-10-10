import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CLASSIC_NOTIFICATION_POLICY } from "./notification-policy";

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
  const started = new Map<number, ReturnType<typeof deferred>>();
  const policies: unknown[] = [];
  let policyFailure: string | null = null;
  const waitForRound = (count: number): Promise<void> => {
    if (rounds.length >= count) return Promise.resolve();
    let ready = started.get(count);
    if (!ready) { ready = deferred(); started.set(count, ready); }
    return ready.promise;
  };
  const source = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
  const start = source.indexOf("const notificationRefreshes =");
  const end = source.indexOf("async function refreshPeers()", start);
  if (start < 0 || end < 0) throw new Error("Notification refresh owner was not found");
  const program = new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(start, end) + "\nreturn refreshThreadNotifications;");
  const refresh = new Function("directory", "db", "projectThreadNotifications", "notificationFeedback", "notificationErrors", "signalSync", "pushNotifications", program)(
<<<<<<< HEAD
    { owners: owners.map(id => ({ id, api: {} })), managerNotificationPolicy: () => ({ ok: true, value: { view: "classic" } }) }, {},
    (_db: unknown, owner: string) => { const work = deferred(); rounds.push({ owner, work }); return work.promise; },
=======
    { owners: owners.map(id => ({ id, api: {} })), managerNotificationPolicy: async () => policyFailure === null
      ? { ok: true, value: CLASSIC_NOTIFICATION_POLICY } : { ok: false, error: { message: policyFailure } } }, {},
    (_db: unknown, owner: string, _api: unknown, _directory: unknown, _published: unknown, policy: unknown) => {
      const work = deferred(); rounds.push({ owner, work }); policies.push(policy);
      started.get(rounds.length)?.resolve();
      return work.promise;
    },
>>>>>>> ffe03030
    (owner: string, message: string | null) => feedback.push({ owner, message }),
    new Map(), () => {}, () => {},
  ) as (cause?: "read" | "change") => Promise<void>;
  return { refresh, rounds, feedback, policies, waitForRound, failPolicy: (message: string | null) => { policyFailure = message; } };
}

test("read-only request bursts join one owner projection and a later read starts fresh", async () => {
  const { refresh, rounds, policies, waitForRound } = harness(["person"]);
  const first = refresh("read");
  const readers = Array.from({ length: 20 }, () => refresh("read"));
<<<<<<< HEAD
  await tick();
  expect(rounds).toHaveLength(1);
  rounds[0]!.work.resolve(); await tick();
=======
  await waitForRound(1);
  expect(rounds).toHaveLength(1);
  expect(policies).toEqual([CLASSIC_NOTIFICATION_POLICY]);
  rounds[0]!.work.resolve(); await Promise.resolve();
>>>>>>> ffe03030
  expect(rounds).toHaveLength(1);
  await Promise.all([first, ...readers]);
  expect(rounds).toHaveLength(1);
  const later = refresh("read");
<<<<<<< HEAD
  await tick();
=======
  await waitForRound(2);
>>>>>>> ffe03030
  expect(rounds).toHaveLength(2);
  rounds[1]!.work.resolve(); await later;
});

test("real events during projection request catchup; readers during catchup do not", async () => {
  const { refresh, rounds, waitForRound } = harness(["person"]);
  const first = refresh("read");
  const events = Array.from({ length: 10 }, () => refresh("change"));
<<<<<<< HEAD
  await tick();
  rounds[0]!.work.resolve();
  await tick();
  expect(rounds).toHaveLength(2);
  const readers = Array.from({ length: 10 }, () => refresh("read"));
  const nextEvent = refresh("change");
  await tick();
  rounds[1]!.work.resolve(); await tick();
=======
  await waitForRound(1);
  rounds[0]!.work.resolve();
  await waitForRound(2);
  expect(rounds).toHaveLength(2);
  const readers = Array.from({ length: 10 }, () => refresh("read"));
  const nextEvent = refresh("change");
  rounds[1]!.work.resolve(); await waitForRound(3);
>>>>>>> ffe03030
  expect(rounds).toHaveLength(3);
  const lastReader = refresh("read");
  await tick();
  rounds[2]!.work.resolve(); await tick();
  expect(rounds).toHaveLength(3);
  await Promise.all([first, ...events, ...readers, nextEvent, lastReader]);
  expect(rounds).toHaveLength(3);
});

test("unavailable policy delays projection without assuming classic delivery and permits retry", async () => {
  const { refresh, rounds, feedback, waitForRound, failPolicy } = harness(["person"]);
  failPolicy("Manager owner unavailable");
  await Promise.all([refresh("read"), refresh("read")]);
  expect(rounds).toHaveLength(0);
  expect(feedback).toEqual([{ owner: "person", message: "Manager owner unavailable" }]);
  failPolicy(null);
  const retry = refresh("read");
  await waitForRound(1);
  expect(rounds).toHaveLength(1);
  rounds[0]!.work.resolve(); await retry;
  expect(feedback.at(-1)).toEqual({ owner: "person", message: null });
});

test("owners project independently and failed refresh keeps feedback and permits retry", async () => {
  const { refresh, rounds, feedback, waitForRound } = harness(["person", "fleet"]);
  const first = refresh("read");
  const joiner = refresh("read");
<<<<<<< HEAD
  await tick();
=======
  await waitForRound(2);
>>>>>>> ffe03030
  expect(rounds.map(round => round.owner)).toEqual(["person", "fleet"]);
  rounds[0]!.work.reject(new Error("Owner unavailable"));
  rounds[1]!.work.resolve(); await tick();
  expect(rounds).toHaveLength(2);
  await Promise.all([first, joiner]);
  expect(feedback).toContainEqual({ owner: "person", message: "Owner unavailable" });
  const retry = refresh("read");
<<<<<<< HEAD
  await tick();
=======
  await waitForRound(4);
>>>>>>> ffe03030
  expect(rounds.map(round => round.owner)).toEqual(["person", "fleet", "person", "fleet"]);
  rounds[2]!.work.resolve(); rounds[3]!.work.resolve(); await retry;
  expect(feedback.at(-2)).toEqual({ owner: "person", message: null });
});
