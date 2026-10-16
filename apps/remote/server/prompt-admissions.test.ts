import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { PromptAdmissions, type PreparedPrompt } from "./prompt-admissions";
import { encodeMessageReply } from "./message-replies";

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture() { const db = new Database(":memory:"); databases.push(db); return { db, admissions: new PromptAdmissions(db) }; }
const input = () => ({ requestId: crypto.randomUUID(), text: "Exact input with attachment /files/exact.png", replyTo: "pi/thread/original", includeMeetingImages: true });
const prepared = (text: string): PreparedPrompt => ({ text, delivery: "pending", images: [{ type: "image", data: "original-frame", mimeType: "image/png" }] });
const good = <T>(value: T) => ({ ok: true as const, value });
const unreachable = async (): Promise<never> => { throw new Error("This effect must not run"); };

test("immutable quote and media preparation survive lost core acknowledgement without a new message identity", async () => {
  const f = fixture(), body = input();
  const quote = { messageId: body.replyTo, text: "Exact original quote", timestamp: 1, sender: { id: "person", name: "Person" } };
  const original = prepared(encodeMessageReply(body.text, quote));
  const sent: PreparedPrompt[] = [];
  expect(await f.admissions.submit("thread", body, {
    prepare: async () => good(original),
    send: async (_threadId, requestId, resolved) => {
      expect(requestId).toBe(body.requestId);
      expect(JSON.parse((f.db.query("SELECT resolved FROM prompt_admissions WHERE request_id=?").get(requestId) as any).resolved)).toEqual(original);
      sent.push(resolved);
      throw new Error("Core accepted but receipt was lost");
    },
  })).toMatchObject({ status: 503, body: { outcome: "pending" } });
  const accepted = await new PromptAdmissions(f.db).submit("thread", body, {
    prepare: unreachable,
    send: async (_threadId, requestId, resolved) => { expect(requestId).toBe(body.requestId); sent.push(resolved); return good({ id: "only-core-message", delivery: "pending" as const }); },
  });
  expect(accepted).toEqual({ status: 202, body: { outcome: "accepted", accepted: true, workId: "only-core-message", delivery: "pending" } });
  expect(sent).toEqual([original, original]);
  expect(await new PromptAdmissions(f.db).submit("thread", body, { prepare: unreachable, send: unreachable })).toEqual(accepted);
  for (const [recipient, modified] of [["other-thread", body], ["thread", { ...body, text: "Changed" }]] as const) {
    expect(await f.admissions.submit(recipient, modified, { prepare: unreachable, send: unreachable })).toMatchObject({ status: 409 });
  }
});

test("historical outbox mode is immutable payload only; core always uses pending delivery", async () => {
  const f = fixture(), body = input();
  const historical = { ...body, delivery: "hardSteer" };
  const accepted = await f.admissions.submit("thread", historical, {
    prepare: async input => { expect(input).not.toHaveProperty("delivery"); return good(prepared(input.text)); },
    send: async () => good({ id: "historical-input", delivery: "pending" as const }),
  });
  expect(accepted).toMatchObject({ status: 202, body: { delivery: "pending" } });
  expect(JSON.parse((f.db.query("SELECT input FROM prompt_admissions WHERE request_id=?").get(body.requestId) as any).input).delivery).toBe("hardSteer");
  expect(await f.admissions.submit("thread", { ...historical, delivery: "queue" }, { prepare: unreachable, send: unreachable })).toMatchObject({ status: 409 });
  for (const invalid of [{ ...body, delivery: "unknown" }, { ...body, text: " " }, { ...body, requestId: "invalid" }]) {
    expect(await f.admissions.submit("thread", invalid, { prepare: unreachable, send: unreachable })).toMatchObject({ status: 400, body: { outcome: "rejected" } });
  }
  const newBody = input();
  expect(await f.admissions.submit("thread", newBody, { prepare: async () => good(prepared(newBody.text)), send: async () => good({ id: "", delivery: "pending" }) })).toMatchObject({ status: 503, body: { outcome: "pending" } });
});

test("failed preparation persistence never contacts core", async () => {
  const f = fixture(), body = input();
  f.db.exec("CREATE TRIGGER refuse_resolution BEFORE UPDATE OF resolved ON prompt_admissions BEGIN SELECT RAISE(ABORT, 'Disk write failed'); END");
  expect(await f.admissions.submit("thread", body, { prepare: async () => good(prepared(body.text)), send: unreachable })).toMatchObject({ status: 503, body: { outcome: "pending" } });
});

test("concurrent identical requests share media preparation and core admission", async () => {
  const f = fixture(), body = input();
  let resolve!: (value: { ok: true; value: PreparedPrompt }) => void;
  const ready = new Promise<{ ok: true; value: PreparedPrompt }>(done => { resolve = done; });
  let sends = 0;
  const effects = { prepare: async () => ready, send: async () => { sends++; return good({ id: "one", delivery: "pending" as const }); } };
  const first = f.admissions.submit("thread", body, effects), second = f.admissions.submit("thread", body, effects);
  resolve(good(prepared(body.text)));
  expect(await first).toEqual(await second);
  expect(sends).toBe(1);
});
