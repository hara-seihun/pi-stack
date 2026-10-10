import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { PhoneReplies, type PhoneReplyHost } from "./phone-replies";
import type { ManagerReply } from "../../../packages/orchestrator/src/core/manager-replies";

function fixture() {
  const db = new Database(":memory:");
  let cursor = 10, online = true, lostAck = false, unsupportedAck = false;
  const receipts: Array<{ cursor: number; reply: ManagerReply }> = [];
  const attempts: Array<{ device: string; id: string; text: string }> = [];
  const displayed = new Set<string>();
  const reads: Array<number | null> = [];
  const host: PhoneReplyHost = {
    managerId: () => "canonical-manager",
    read: async input => { reads.push(input.after); return { ok: true, value: { managerThreadId: "canonical-manager", cursor, replies: input.after === null ? [] : receipts.filter(item => item.cursor > input.after!).map(item => item.reply) } }; },
    online: () => online,
    send: async (device, id, text) => {
      attempts.push({ device, id, text }); displayed.add(`${device}:${id}`);
      if (lostAck) return { type: "result", id: "transport-id", ok: false, error: { code: "unconfirmed", message: "Acknowledgement lost" } };
      return { type: "result", id: "transport-id", ok: true, result: unsupportedAck ? {} : { displayed: true, receiptId: id, duplicate: attempts.length > 1 } };
    },
    feedback: () => {},
  };
  const publish = (id = "execution-11", text = "Canonical host reply") => { receipts.push({ cursor: ++cursor, reply: { id: `manager-reply:canonical-manager:${id}`, text, time: cursor * 1000, outcome: "complete" } }); };
  return { db, host, attempts, displayed, reads, publish, offline: () => { online = false; }, online: () => { online = true; }, lose: () => { lostAck = true; }, acknowledge: () => { lostAck = false; }, unsupported: () => { unsupportedAck = true; } };
}

test("authorized device subscribes at canonical head before admission; remote replies survive both-host restart and lost display ack", async () => {
  const f = fixture(); let fanout = new PhoneReplies(f.db, f.host);
  expect((await fanout.bind("phone", true)).ok).toBe(true);
  await fanout.reconcile();
  expect(f.reads[0]).toBeNull();
  f.offline(); f.publish();
  expect((await fanout.reconcile()).ok).toBe(true);
  expect(f.attempts).toHaveLength(0);
  expect(f.db.query("SELECT cursor FROM phone_manager_reply_devices").get()).toEqual({ cursor: 11 });
  await fanout.close();
  fanout = new PhoneReplies(f.db, f.host);
  f.online(); f.lose();
  await fanout.bind("phone", true); await fanout.reconcile();
  expect(f.attempts[0]).toMatchObject({ device: "phone", id: "manager-reply:canonical-manager:execution-11", text: "Canonical host reply" });
  expect(f.db.query("SELECT count(*) AS count FROM phone_manager_reply_outbox").get()).toEqual({ count: 1 });
  await fanout.close();
  fanout = new PhoneReplies(f.db, f.host); f.acknowledge();
  await fanout.bind("phone", true); await fanout.reconcile();
  expect(f.attempts.at(-1)).toEqual(f.attempts[0]);
  expect(f.displayed.size).toBe(1);
  expect(f.db.query("SELECT count(*) AS count FROM phone_manager_reply_outbox").get()).toEqual({ count: 0 });
  await fanout.close(); f.db.close();
});

test("only current authenticated enabled devices receive independent copies of the person's manager receipt", async () => {
  const f = fixture(), fanout = new PhoneReplies(f.db, f.host);
  await fanout.bind("phone", true); await fanout.reconcile();
  await fanout.bind("tablet", true); await fanout.reconcile();
  f.publish(); await fanout.reconcile();
  expect(f.attempts.map(item => item.device).sort()).toEqual(["phone", "tablet"]);
  expect(new Set(f.attempts.map(item => item.id)).size).toBe(1);
  await fanout.close();
  const restarted = new PhoneReplies(f.db, f.host);
  const reads = f.reads.length;
  f.publish("later"); await restarted.reconcile();
  expect(f.reads.length).toBe(reads); // Persisted row alone is not a current device grant.
  await restarted.close(); f.db.close();
});

test("overlay-off cancels unsent presentation and re-enable starts at the new canonical head", async () => {
  const f = fixture(), fanout = new PhoneReplies(f.db, f.host);
  await fanout.bind("phone", true); await fanout.reconcile();
  f.offline(); f.publish("while-offline"); await fanout.reconcile();
  await fanout.bind("phone", false);
  f.publish("while-disabled"); f.online();
  await fanout.bind("phone", true); await fanout.reconcile();
  expect(f.attempts).toHaveLength(0);
  f.publish("after-enable"); await fanout.reconcile();
  expect(f.attempts.map(item => item.id)).toEqual(["manager-reply:canonical-manager:after-enable"]);
  await fanout.close(); f.db.close();
});

test("generic acceptance is not a displayed-receipt acknowledgement", async () => {
  const f = fixture(), fanout = new PhoneReplies(f.db, f.host);
  await fanout.bind("phone", true); await fanout.reconcile();
  f.unsupported(); f.publish();
  expect((await fanout.reconcile()).ok).toBe(false);
  expect(f.db.query("SELECT count(*) AS count FROM phone_manager_reply_outbox").get()).toEqual({ count: 1 });
  await fanout.close(); f.db.close();
});

test("unavailable canonical host refuses a new subscription before any phone message can be admitted", async () => {
  const f = fixture(); f.host.read = async () => ({ ok: false, error: { code: "unavailable", message: "Canonical host offline" } });
  const fanout = new PhoneReplies(f.db, f.host);
  expect((await fanout.bind("phone", true)).ok).toBe(false);
  expect(f.db.query("SELECT count(*) AS count FROM phone_manager_reply_devices").get()).toEqual({ count: 0 });
  await fanout.close(); f.db.close();
});
