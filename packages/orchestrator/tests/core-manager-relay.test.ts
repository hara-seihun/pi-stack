import { expect, test } from "bun:test";
import type { ThreadApi, Thread, ManagerQuestionCustodyRequest } from "../src/threads/contracts.js";
import { openSqlite } from "../src/sqlite.js";
import { CoreManagerRelay, type CoreManagerRelayConfig } from "../src/core/manager-relay.js";
import { CoreManagerNotices } from "../src/core/manager-notices.js";

const resource = { id: "remote-person", kind: "project", ownerId: "person" } as any;
const config = (): CoreManagerRelayConfig => ({ scopeId: "person", environmentId: "local", callbackUrl: "http://remote.test/v1/core/manager-relay", canonicalManager: { environmentId: "local", threadId: "manager" }, remoteEnvironments: [{ id: "remote", resource }, { id: "other", resource }], adoptedOrigins: [] });
const receive = { action: "receive", threadId: "manager", originThreadId: "origin", requestId: "original-custody", questions: [], deadlineAt: 1 } as ManagerQuestionCustodyRequest;
const request = (origin = "remote", confirmed = true) => new Request("http://core.test", { headers: { "x-pi-remote-manager-origin": origin, ...(confirmed ? { "x-pi-core-router-confirmed": "true" } : {}) } });

test("core records trusted origin before native custody, refuses conflicts and preserves routing after restart", async () => {
  const db = openSqlite(":memory:");
  const transport = async () => Response.json({ ok: true, value: {} });
  const relay = new CoreManagerRelay(config(), db, transport, () => ({ ok: true, value: undefined }));
  let dispatches = 0;
  const dispatch = async () => {
    dispatches++;
    expect(relay.questionOwner("origin")?.id).toBe("manager-origin:remote");
    return { ok: true as const, value: { accepted: true as const } };
  };
  expect((await relay.receive(request(), receive, false, dispatch)).ok).toBe(false);
  expect((await relay.receive(request("remote", false), receive, true, dispatch)).ok).toBe(false);
  expect(dispatches).toBe(0);
  expect((await relay.receive(request(), receive, true, dispatch)).ok).toBe(true);
  expect(await relay.receive(request("other"), receive, true, dispatch)).toMatchObject({ ok: false, error: { code: "conflict" } });
  expect(dispatches).toBe(1);
  const restarted = new CoreManagerRelay(config(), db, transport, () => ({ ok: true, value: undefined }));
  expect(restarted.questionOwner("origin")?.id).toBe("manager-origin:remote");
  db.close();
});

test("remote manager transport preserves request identity and rechecks current resource authority", async () => {
  const db = openSqlite(":memory:");
  const value = config(); value.canonicalManager = { environmentId: "remote", threadId: "manager" };
  let allowed = true, contacts = 0;
  const relay = new CoreManagerRelay(value, db, async (input, init) => {
    contacts++;
    expect(String(input)).toBe("http://remote.test/v1/core/manager-relay/managerQuestionCustody");
    expect(JSON.parse(String(init?.body))).toEqual({ input: receive, environmentId: "remote" });
    return Response.json({ ok: true, value: { accepted: true } });
  }, () => allowed ? { ok: true, value: undefined } : { ok: false, error: { code: "unavailable", message: "Grant revoked" } });
  expect((await relay.managerOwner!.api.managerQuestionCustody(receive)).ok).toBe(true);
  allowed = false;
  expect((await relay.managerOwner!.api.managerQuestionCustody(receive)).ok).toBe(false);
  expect(contacts).toBe(1);
  db.close();
});

test("core routes notices without Remote and retains exact outbox identity across uncertain acknowledgement", async () => {
  const db = openSqlite(":memory:");
  const thread = { id: "origin", title: "Task title" } as Thread;
  const attention = { seq: 3, threadId: thread.id, summary: "Act now", time: 3000 };
  let listener: (() => void) | null = null;
  const api = {
    list: async () => ({ ok: true, value: { threads: [thread] } }),
    settlements: async (after: number) => ({ ok: true, value: { cursor: after, items: [] } }),
    questionEvents: async (after: number) => ({ ok: true, value: { cursor: after, items: [] } }),
    attentionEvents: async (after: number) => ({ ok: true, value: { cursor: 3, items: after < 3 ? [attention] : [] } }),
  } as unknown as ThreadApi;
  const inputs: unknown[] = [];
  let acknowledged = false;
  const directory = {
    managerNotificationPolicy: async () => ({ ok: true as const, value: { view: "mono" as const, managerThreadId: "manager" } }),
    send: async (input: unknown) => {
      inputs.push(input);
      return acknowledged ? { ok: true as const, value: {} as any } : { ok: false as const, error: { code: "unavailable" as const, message: "Lost acknowledgement" } };
    },
  };
  const options = { scopeId: "person", notificationOwnerId: "person", adoptedCursors: { settlements: 8, attention: 2, questions: 4 }, subscribe: (notify: () => void) => { listener = notify; return () => { listener = null; }; }, feedback: () => {} };
  const first = new CoreManagerNotices(options, db, api, directory);
  expect((await first.start()).ok).toBe(false);
  expect(inputs).toHaveLength(1);
  expect(inputs[0]).toMatchObject({ requestId: "manager-notice:person:attention:3", threadId: "manager", senderId: thread.id });
  expect(db.prepare("SELECT cursor FROM core_manager_notice_cursor WHERE kind='attention'").get()).toMatchObject({ cursor: 3 });
  expect(db.prepare("SELECT count(*) AS count FROM core_manager_notice_outbox").get()).toMatchObject({ count: 1 });
  await first.close();
  acknowledged = true;
  const restarted = new CoreManagerNotices(options, db, api, directory);
  expect((await restarted.start()).ok).toBe(true);
  expect(inputs[1]).toEqual(inputs[0]);
  expect(db.prepare("SELECT count(*) AS count FROM core_manager_notice_outbox").get()).toMatchObject({ count: 0 });
  expect(listener).not.toBeNull();
  await restarted.close(); db.close();
});
