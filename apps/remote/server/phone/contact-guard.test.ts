import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contactGuard } from "./contact-guard";

const priorId = "4208e41f-cafe-4bc5-991f-02dcb8f0f723";
const brief = { requestId: "2208e41f-cafe-4bc5-991f-02dcb8f0f723", to: "+15555550123", purpose: "Approved call", shareableFacts: [], opening: "Hello", maxSeconds: 60 };
function fixture() {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE calls(id TEXT,brief TEXT,started_at INTEGER,accepted_at INTEGER,ended_at INTEGER,cleanup INTEGER,dial_state TEXT)");
  const add = (dial: string, end: number | null = 1100, accepted: number | null = 1000, cleanup = 1) => db.query("INSERT INTO calls VALUES(?,?,?,?,?,?,?)").run(priorId, JSON.stringify(brief), 900, accepted, end, cleanup, dial);
  return { db, add };
}
test("unfinished or uncertain recipient blocks distinct requests; unrelated numbers proceed", () => {
  const f = fixture();
  try {
    f.add("none", null, null);
    expect(contactGuard(f.db, brief, {}, 2000)).toMatchObject({ ok: false, code: "recipient-busy", callId: priorId });
    expect(contactGuard(f.db, { ...brief, to: "+15555550124" }, {}, 2000)).toEqual({ ok: true });
    f.db.exec("UPDATE calls SET ended_at=1100,dial_state='uncertain'");
    expect(contactGuard(f.db, brief, {}, 2000)).toMatchObject({ ok: false, code: "recipient-dial-uncertain" });
  } finally { f.db.close(); }
});
test("accepted contact counts despite media failure; self-authored followUpOf is not an override", () => {
  const f = fixture();
  try {
    f.add("accepted");
    const followup = { ...brief, followUpOf: priorId };
    expect(contactGuard(f.db, followup, {}, 2000)).toMatchObject({ ok: false, code: "recipient-cooldown", retryAt: 7201000 });
    expect(contactGuard(f.db, brief, {}, 7201000)).toEqual({ ok: true });
    f.db.exec("UPDATE calls SET accepted_at=NULL");
    expect(contactGuard(f.db, brief, {}, 2000)).toMatchObject({ ok: false, code: "recipient-cooldown", retryAt: 7200900 });
  } finally { f.db.close(); }
});
test("operator approval binds exact next request, latest call, recipient and completed reconciliation", () => {
  const f = fixture();
  try {
    f.add("accepted");
    const config = { followUpApprovalsFile: "/operator" };
    const approval = { followUpOf: priorId, to: brief.to, reconciledAt: 1500, reason: "Prior provider effects reconciled; operator approved follow-up" };
    const read = (_path: unknown, rootOnly: boolean) => { expect(rootOnly).toBe(true); return { [brief.requestId]: approval }; };
    expect(contactGuard(f.db, { ...brief, followUpOf: priorId }, config, 2000, read)).toEqual({ ok: true });
    expect(contactGuard(f.db, brief, config, 2000, read)).toMatchObject({ code: "recipient-cooldown" });
    expect(contactGuard(f.db, { ...brief, requestId: priorId, followUpOf: priorId }, config, 2000, read)).toMatchObject({ code: "recipient-cooldown" });
    approval.reconciledAt = 1000;
    expect(contactGuard(f.db, { ...brief, followUpOf: priorId }, config, 2000, read)).toMatchObject({ code: "recipient-cooldown" });
    approval.reconciledAt = 1500;
    f.db.exec("UPDATE calls SET cleanup=0");
    expect(contactGuard(f.db, { ...brief, followUpOf: priorId }, config, 2000, read)).toMatchObject({ code: "recipient-cooldown" });
  } finally { f.db.close(); }
});
test("live holds always win; invalid or missing configured files fail closed", () => {
  const f = fixture(), dir = mkdtempSync(join(tmpdir(), "phone-holds-")), holdsFile = join(dir, "holds.json");
  try {
    f.add("accepted");
    writeFileSync(holdsFile, JSON.stringify({ [brief.to]: "Operator hold: do not contact" }));
    const followup = { ...brief, followUpOf: priorId };
    expect(contactGuard(f.db, followup, { holdsFile }, 2000)).toMatchObject({ code: "recipient-held", error: "Operator hold: do not contact" });
    writeFileSync(holdsFile, "{}");
    expect(contactGuard(f.db, followup, { holdsFile }, 2000)).toMatchObject({ code: "recipient-cooldown" });
    writeFileSync(holdsFile, "broken");
    expect(contactGuard(f.db, brief, { holdsFile }, 2000)).toMatchObject({ code: "contact-policy-unavailable" });
    expect(contactGuard(f.db, brief, { holdsFile: join(dir, "absent") }, 2000)).toMatchObject({ code: "contact-policy-unavailable" });
    writeFileSync(holdsFile, JSON.stringify({ [brief.requestId]: { followUpOf: priorId, to: brief.to, reconciledAt: 1500, reason: "Self minted" } }), { mode: 0o600 });
    if (process.getuid!() !== 0) expect(contactGuard(f.db, followup, { followUpApprovalsFile: holdsFile }, 2000)).toMatchObject({ code: "contact-policy-unavailable" });
  } finally { f.db.close(); rmSync(dir, { recursive: true, force: true }); }
});
