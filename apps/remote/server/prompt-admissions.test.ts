import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { PromptAdmissions, type PreparedPrompt, type PromptAdmissionEffects, type PromptFailure } from "./prompt-admissions";
import { encodeMessageReply } from "./message-replies";

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture() {
  const db = new Database(":memory:"); databases.push(db);
  return { db, admissions: new PromptAdmissions(db) };
}
const input = () => ({ requestId: crypto.randomUUID(), text: "Response\n\nThe following files were attached to this message:\n- /files/exact.png", delivery: "hardSteer" as const, replyTo: "pi/thread/original", includeMeetingImages: true });
const prepared = (text: string): PreparedPrompt => ({ text, delivery: "hardSteer", images: [{ type: "image", data: "original-frame", mimeType: "image/png" }] });
const good = <T>(value: T) => ({ ok: true as const, value });
const unreachable = async (): Promise<never> => { throw new Error("This effect must not run"); };

test("resolved quote, attachment body and meeting image bytes persist before first send and survive lost acknowledgement/restart", async () => {
  const f = fixture();
  const body = input();
  const quote = { messageId: body.replyTo, text: "Exact original quote", timestamp: 1, sender: { id: "person", name: "Person" } };
  const original = prepared(encodeMessageReply(body.text, quote));
  let durableWorkId: string | null = null;
  const sent: PreparedPrompt[] = [];
  const effects: PromptAdmissionEffects = {
    prepare: async () => good(original),
    send: async (_sessionId, requestId, resolved) => {
      expect(requestId).toBe(body.requestId);
      const persisted = f.db.query("SELECT resolved FROM prompt_admissions WHERE request_id=?").get(requestId) as { resolved: string };
      expect(JSON.parse(persisted.resolved)).toEqual(original);
      durableWorkId = "only-one-owner-message";
      sent.push(resolved);
      throw new Error("Owner admitted the prompt but acknowledgement was lost");
    },
  };
  expect(await f.admissions.submit("thread", body, effects)).toMatchObject({ status: 503, body: { outcome: "pending" } });
  const restarted = new PromptAdmissions(f.db);
  const accepted = await restarted.submit("thread", body, {
    prepare: unreachable,
    send: async (_sessionId, requestId, resolved) => {
      expect(requestId).toBe(body.requestId); sent.push(resolved);
      return good({ id: durableWorkId!, delivery: "hardSteer" as const });
    },
  });
  expect(accepted).toEqual({ status: 202, body: { outcome: "accepted", accepted: true, workId: "only-one-owner-message", delivery: "hardSteer" } });
  expect(sent).toEqual([original, original]);
  expect(await new PromptAdmissions(f.db).submit("thread", body, { prepare: unreachable, send: unreachable })).toEqual(accepted);
});

test("request collision rejects changed input and recipient without returning someone else's admission", async () => {
  const f = fixture();
  const body = input();
  await f.admissions.submit("thread", body, { prepare: async () => good(prepared(body.text)), send: async () => good({ id: "work", delivery: "hardSteer" }) });
  for (const [recipient, modified] of [["another-thread", body], ["thread", { ...body, text: "Changed" }], ["thread", { ...body, delivery: "queue" }], ["thread", { ...body, replyTo: "pi/thread/another" }]] as const) {
    expect(await f.admissions.submit(recipient, modified, { prepare: unreachable, send: unreachable })).toMatchObject({ status: 409, body: { outcome: "rejected", code: "conflict" } });
  }
});

test("validation errors are explicit rejection and immutable owner failures remain pending rather than false rejection", async () => {
  const f = fixture();
  const body = input();
  for (const invalid of [{ ...body, delivery: undefined }, { ...body, text: " " }, { ...body, requestId: "invalid" }, { ...body, command: "compact" }, { ...body, includeMeetingImages: "true" }]) {
    expect(await f.admissions.submit("thread", invalid, { prepare: unreachable, send: unreachable })).toMatchObject({ status: 400, body: { outcome: "rejected" } });
  }
  expect(await f.admissions.submit("thread", body, {
    prepare: async () => good(prepared(body.text)),
    send: async () => ({ ok: false, error: { code: "unavailable", message: "Owner acknowledgement unconfirmed" } }),
  })).toMatchObject({ status: 503, body: { outcome: "pending", error: "Owner acknowledgement unconfirmed" } });
  expect(await f.admissions.submit("thread", body, {
    prepare: unreachable,
    send: async () => good({ id: "accepted-later", delivery: "hardSteer" }),
  })).toMatchObject({ status: 202, body: { workId: "accepted-later" } });
});

const failureCases = [
  ["invalid_request", 400, "rejected"],
  ["not_found", 404, "rejected"],
  ["conflict", 409, "rejected"],
  ["forbidden", 403, "rejected"],
  ["unavailable", 503, "pending"],
  ["no_pending_messages", 503, "pending"],
  ["cancellation_failed", 503, "pending"],
] as const satisfies ReadonlyArray<readonly [PromptFailure["code"], number, "rejected" | "pending"]>;

test.each(failureCases)("%s during preparation or send yields %i/%s with correct restart custody", async (code, status, outcome) => {
  for (const phase of ["prepare", "send"] as const) {
    const f = fixture();
    const body = input();
    const fail = async () => ({ ok: false as const, error: { code, message: "Admission failure" } });
    const response = await f.admissions.submit("thread", body, {
      prepare: phase === "prepare" ? fail : async () => good(prepared(body.text)),
      send: phase === "send" ? fail : unreachable,
    });
    expect(response).toEqual({ status, body: { outcome, code: outcome === "pending" ? "unavailable" : code, error: "Admission failure" } });
    const restarted = new PromptAdmissions(f.db);
    if (outcome === "rejected") {
      expect(await restarted.submit("thread", body, { prepare: unreachable, send: unreachable })).toEqual(response);
    } else {
      expect(await restarted.submit("thread", body, {
        prepare: phase === "prepare" ? async () => good(prepared(body.text)) : unreachable,
        send: async () => good({ id: "accepted-later", delivery: "hardSteer" }),
      })).toMatchObject({ status: 202, body: { workId: "accepted-later" } });
    }
  }
});

test("an undescribed failure code reports the protocol defect and leaves admission unconfirmed", async () => {
  const f = fixture();
  const body = input();
  const response = await f.admissions.submit("thread", body, {
    prepare: async () => ({ ok: false, error: { code: "unknown-owner-state", message: "Not a known failure" } as unknown as PromptFailure }),
    send: unreachable,
  });
  expect(response).toEqual({ status: 503, body: { outcome: "pending", code: "unavailable", error: 'Prompt admission failure: undescribed state "unknown-owner-state"' } });
  expect(await new PromptAdmissions(f.db).submit("thread", body, {
    prepare: async () => good(prepared(body.text)),
    send: async () => good({ id: "accepted-after-protocol-repair", delivery: "hardSteer" }),
  })).toMatchObject({ status: 202, body: { workId: "accepted-after-protocol-repair" } });
});

test("concurrent identical requests share effects; concurrent collisions do not share acceptance", async () => {
  const f = fixture();
  const body = input();
  let resolve!: (value: { ok: true; value: PreparedPrompt }) => void;
  const preparing = new Promise<{ ok: true; value: PreparedPrompt }>(done => { resolve = done; });
  let prepares = 0, sends = 0;
  const effects: PromptAdmissionEffects = { prepare: async () => { prepares++; return preparing; }, send: async () => { sends++; return good({ id: "one", delivery: "hardSteer" }); } };
  const first = f.admissions.submit("thread", body, effects);
  const second = f.admissions.submit("thread", body, effects);
  expect(await f.admissions.submit("thread", { ...body, text: "Changed during admission" }, effects)).toMatchObject({ status: 409, body: { outcome: "rejected" } });
  resolve(good(prepared(body.text)));
  expect(await first).toEqual(await second);
  expect(prepares).toBe(1); expect(sends).toBe(1);
});

test("a malformed owner admission is pending rather than fabricated acceptance", async () => {
  const f = fixture();
  const body = input();
  expect(await f.admissions.submit("thread", body, { prepare: async () => good(prepared(body.text)), send: async () => good({ id: "", delivery: "queue" }) }))
    .toMatchObject({ status: 503, body: { outcome: "pending" } });
  expect(f.admissions.has(body.requestId)).toBe(true);
  const persisted = f.db.query("SELECT response FROM prompt_admissions WHERE request_id=?").get(body.requestId) as { response: string | null };
  expect(persisted.response).toBeNull();
});

test("if resolved persistence fails, send is never invoked", async () => {
  const f = fixture();
  const body = input();
  f.db.exec("CREATE TRIGGER refuse_resolution BEFORE UPDATE OF resolved ON prompt_admissions BEGIN SELECT RAISE(ABORT, 'Disk write failed'); END");
  expect(await f.admissions.submit("thread", body, { prepare: async () => good(prepared(body.text)), send: unreachable }))
    .toMatchObject({ status: 503, body: { outcome: "pending", error: expect.stringContaining("Disk write failed") } });
});

test("if saving terminal acknowledgement fails after owner admission, restart resends exactly the resolved input", async () => {
  const f = fixture();
  const body = input();
  const original = prepared(body.text);
  f.db.exec("CREATE TRIGGER refuse_ack BEFORE UPDATE OF response ON prompt_admissions BEGIN SELECT RAISE(ABORT, 'Receipt write failed'); END");
  expect(await f.admissions.submit("thread", body, { prepare: async () => good(original), send: async () => good({ id: "durable-owner-receipt", delivery: "hardSteer" }) }))
    .toMatchObject({ status: 503, body: { outcome: "pending" } });
  f.db.exec("DROP TRIGGER refuse_ack");
  expect(await new PromptAdmissions(f.db).submit("thread", body, { prepare: unreachable, send: async (_threadId, _requestId, resolved) => {
    expect(resolved).toEqual(original);
    return good({ id: "durable-owner-receipt", delivery: "hardSteer" });
  } })).toMatchObject({ status: 202, body: { workId: "durable-owner-receipt" } });
});
