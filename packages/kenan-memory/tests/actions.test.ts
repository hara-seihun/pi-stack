import { afterEach, expect, test } from "bun:test";
import { validActionResponse } from "../src/action-response.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ActionStore, canonicalRecipient, openActionStore, type ActionInput, type ActionResult, type ActionEvidence } from "../src/actions.js";
const roots: string[] = [];
const stores: ActionStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) { try { store.close(); } catch {} } for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const root = () => { const path = mkdtempSync(join(tmpdir(), "external-actions-")); roots.push(path); return path; };
const store = (path = root(), owner = "synthetic-alice") => { const value = new ActionStore(path, owner); stores.push(value); return value; };
const value = <T>(result: ActionResult<T>): T => { if (!result.ok) throw new Error(JSON.stringify(result)); return result.value; };
const receipt: ActionEvidence = { kind: "provider-receipt", reference: "fake-provider:1", detail: "Synthetic provider accepted one effect" };
const rejection: ActionEvidence = { kind: "provider-rejection", reference: "fake-provider:rejected", detail: "Synthetic provider definitively rejected before accepting any effect" };
const observation: ActionEvidence = { kind: "operator-observation", reference: "fake-sender:retired", detail: "Synthetic sender is stopped; reconciliation inspected its provider receipt" };
const input = (changes: Partial<ActionInput> = {}): ActionInput => ({ intentKey: "order:synthetic:status", recipients: ["+1 (202) 555-0123"], transport: "telephone", payload: { purpose: "Check synthetic order status", facts: [] }, requestId: crypto.randomUUID(), threadId: "synthetic-worker", ...changes });

test("malformed authority success cannot grant a dispatch or partially populated receipt", () => {
  expect(validActionResponse("dispatch", { ok: true, value: {} })).toBe(false);
  expect(validActionResponse("claim", { ok: true, value: { id: "action", revision: 2 } })).toBe(false);
  expect(validActionResponse("submit", { ok: true, value: { disposition: "created", action: { id: "action" } } })).toBe(false);
  expect(validActionResponse("inspect", { ok: false, error: "invented-error", message: "bad" })).toBe(false);
  expect(validActionResponse("dispatch", { ok: true, value: null })).toBe(true);
  const s = store(); const action = value(s.submit(input())).action;
  expect(validActionResponse("inspect", { ok: true, value: action })).toBe(true);
  expect(validActionResponse("inspect", { ok: true, value: { ...action, state: "unknown" } })).toBe(false);
});

test("same business intent across workers/new UUIDs returns one result and rejects payload conflict", () => {
  const path = root(), a = store(path), b = store(path);
  const first = value(a.submit(input())).action;
  const second = value(b.submit(input({ recipients: ["signal:+12025550123"] })));
  expect(second.disposition).toBe("existing"); expect(second.action.id).toBe(first.id);
  expect(a.submit(input({ payload: { changed: true } }))).toMatchObject({ ok: false, error: "payload-conflict" });
  const ticket = value(a.claim(first.id, "worker-a")); expect(b.claim(first.id, "worker-b")).toMatchObject({ ok: false, error: "fenced" });
  value(a.dispatch(ticket)); expect(a.dispatch(ticket)).toMatchObject({ ok: false, error: "fenced" });
  value(a.finish(ticket, "succeeded", { providerId: "fake:1" }, receipt));
  expect(value(b.submit(input())).action).toMatchObject({ id: first.id, state: "succeeded", result: { providerId: "fake:1" } });
});

test("rephrasing or switching transport cannot reset unresolved recipient contact", () => {
  const s = store(); const first = value(s.submit(input())).action;
  const changed = value(s.submit(input({ intentKey: "please ask a different way", transport: "signal", payload: { body: "Rephrase" } })));
  expect(changed).toMatchObject({ disposition: "recipient-held", action: { id: first.id } });
  const ticket = value(s.claim(first.id, "a")); value(s.dispatch(ticket)); value(s.finish(ticket, "succeeded", null, receipt));
  expect(value(s.submit(input({ intentKey: "new UUID purpose" }))).disposition).toBe("recipient-held");
});

test("crash after provider effect before receipt stays fenced across restart and only affirmative reconciliation changes it", () => {
  const path = root(), s = store(path); const action = value(s.submit(input())).action;
  const ticket = value(s.claim(action.id, "retired-process")); value(s.dispatch(ticket));
  // Fake provider performed an effect. No finish receipt exists.
  const restarted = store(path);
  expect(value(restarted.submit(input())).action.state).toBe("inflight");
  expect(restarted.claim(action.id, "new-process")).toMatchObject({ ok: false, error: "fenced" });
  expect(restarted.reconcile(action.id, ticket.revision, "no-effect-confirmed", rejection, "new-process")).toMatchObject({ ok: false, error: "fenced" });
  const unknown = value(restarted.recover(action.id, ticket.revision, observation, "transport-owner"));
  expect(unknown.state).toBe("uncertain"); expect(s.finish(ticket, "succeeded", null, receipt)).toMatchObject({ ok: false, error: "fenced" });
  expect(restarted.reconcile(action.id, unknown.revision, "no-effect-confirmed", observation, "operator")).toMatchObject({ ok: false, error: "invalid-input" });
  const known = value(restarted.reconcile(action.id, unknown.revision, "effect-confirmed", receipt, "operator"));
  expect(known.state).toBe("succeeded"); expect(value(restarted.submit(input({ intentKey: "retry-differently" }))).disposition).toBe("recipient-held");
});

test("no-effect proof permits explicit fenced retry; uncertainty never does", () => {
  const s = store(); const action = value(s.submit(input())).action;
  const ticket = value(s.claim(action.id, "worker")); value(s.dispatch(ticket));
  const unknown = value(s.finish(ticket, "uncertain", null, observation));
  expect(s.retryNoEffect(action.id, unknown.revision, rejection, "worker")).toMatchObject({ ok: false, error: "fenced" });
  const failed = value(s.reconcile(action.id, unknown.revision, "no-effect-confirmed", rejection, "operator"));
  expect(value(s.submit(input())).action.state).toBe("failed-before-effect");
  const ready = value(s.retryNoEffect(action.id, failed.revision, rejection, "operator"));
  expect(ready.state).toBe("accepted"); const next = value(s.claim(action.id, "worker-2"));
  expect(next.revision).toBeGreaterThan(ticket.revision); expect(s.dispatch(ticket)).toMatchObject({ ok: false, error: "fenced" });
  value(s.dispatch(next));
});

test("held recipient and holds added during async preparation stop dispatch", () => {
  const s = store(); value(s.holdRecipient("+12025550123", "Synthetic explicit hold", "operator"));
  const held = value(s.submit(input())).action; expect(held.state).toBe("held");
  expect(s.claim(held.id, "worker")).toMatchObject({ ok: false, error: "fenced" });
  value(s.releaseRecipient("+12025550123", observation, "operator"));
  const ticket = value(s.claim(held.id, "worker"));
  value(s.holdRecipient("tel:+12025550123", "Hold while preparing", "operator"));
  expect(s.dispatch(ticket)).toMatchObject({ ok: false, error: "fenced" });
  value(s.finish(ticket, "failed-before-effect", null, rejection));
  expect(value(s.submit(input({ intentKey: "rephrased" }))).action.state).toBe("held");
});

test("accountable followup is atomic, keeps lineage, and new retry IDs return same followup", () => {
  const s = store(); const first = value(s.submit(input())).action;
  const t = value(s.claim(first.id, "worker")); value(s.dispatch(t)); const done = value(s.finish(t, "succeeded", null, receipt));
  const nextInput = input({ intentKey: "order:synthetic:new-evidence", payload: { purpose: "Substantive followup" } });
  const next = value(s.followup(first.id, done.revision, nextInput, observation));
  expect(next.disposition).toBe("created"); expect(next.action.id).not.toBe(first.id);
  const again = value(s.followup(first.id, done.revision, { ...nextInput, requestId: crypto.randomUUID() }, observation));
  expect(again.disposition).toBe("existing"); expect(again.action.id).toBe(next.action.id);
  expect(s.followup(first.id, done.revision, input({ intentKey: "yet another" }), observation)).toMatchObject({ ok: false, error: "fenced" });
  expect(value(s.inspect(first.id)).resolved).toBe(true);
});

test("synthetic owner isolation including same recipient and forged action IDs", () => {
  const path = root(), alice = store(path, "alice"), bob = store(path, "bob");
  const a = value(alice.submit(input())).action, b = value(bob.submit(input())).action;
  expect(a.id).not.toBe(b.id); expect(bob.inspect(a.id)).toMatchObject({ ok: false, error: "not-found" });
  expect(bob.claim(a.id, "forged")).toMatchObject({ ok: false, error: "not-found" });
  value(alice.holdRecipient("+12025550123", "Alice hold", "alice"));
  const bt = value(bob.claim(b.id, "bob")); value(bob.dispatch(bt));
  expect(value(bob.list()).map(a => a.owner)).toEqual(["bob"]);
});

test("malformed/config-unset input produces a typed error, never a global dispatch store", () => {
  expect(() => openActionStore({ USER: "alice", PI_ACTION_AUTHORITY_LOCAL_FIXTURE: "1" })).toThrow("no global fallback");
  expect(openActionStore({ USER: "alice" }).constructor.name).toBe("ActionClient");
  const s = store(); expect(s.submit(input({ payload: undefined }))).toMatchObject({ ok: false, error: "invalid-input" });
  expect(s.submit(input({ recipients: [] }))).toMatchObject({ ok: false, error: "invalid-input" });
  expect(canonicalRecipient("Name <ALICE@EXAMPLE.test>")).toBe("mailto:alice@example.test");
});

test("late verified Signal/phone aliases propagate prior effects and holds across transports", () => {
  const s = store();
  const prior = value(s.submit(input({ recipients: ["signal:synthetic-aci"], transport: "signal.send" }))).action;
  value(s.linkRecipients(["signal:synthetic-aci", "+12025550123"], "verified-backend"));
  expect(value(s.submit(input({ intentKey: "different phone purpose" }))).disposition).toBe("recipient-held");
  expect(value(s.submit(input({ recipients: ["+12025550123"], transport: "signal.send" }))).action.id).toBe(prior.id);
  value(s.holdRecipient("+12025550123", "Verified hold", "operator"));
  expect(s.claim(prior.id, "worker")).toMatchObject({ ok: false, error: "fenced" });
});

test("late aliases preserve resolved business identity and changed recipient sets conflict", () => {
  const s = store();
  const action = value(s.submit(input({ recipients: ["signal:resolved-aci"], transport: "signal.send" }))).action;
  const t = value(s.claim(action.id, "worker")); value(s.dispatch(t));
  expect(s.finish(t, "succeeded", null, observation)).toMatchObject({ ok: false, error: "invalid-input" });
  const done = value(s.finish(t, "succeeded", null, receipt));
  value(s.reconcile(action.id, done.revision, "resolve-purpose", observation, "operator"));
  value(s.linkRecipients(["signal:resolved-aci", "+12025550123"], "verified-backend"));
  expect(value(s.submit(input({ transport: "signal.send" }))).action.id).toBe(action.id);
  const unresolved = value(s.submit(input({ intentKey: "unresolved-new-purpose" }))).action;
  expect(s.submit(input({ intentKey: "unresolved-new-purpose", recipients: ["+12025550123", "other@example.test"] }))).toMatchObject({ ok: false, error: "payload-conflict", action: { id: unresolved.id } });
});

test("aliases discovering two unresolved effects hold both instead of silently merging", () => {
  const s = store();
  const a = value(s.submit(input({ recipients: ["signal:aci-a"] }))).action;
  const b = value(s.submit(input({ recipients: ["+12025550123"] }))).action;
  value(s.linkRecipients(["signal:aci-a", "+12025550123"], "verified-backend"));
  expect(s.claim(a.id, "a")).toMatchObject({ ok: false, error: "fenced" });
  expect(s.claim(b.id, "b")).toMatchObject({ ok: false, error: "fenced" });
  expect(value(s.list())).toHaveLength(2);
});

test("twelve independent processes atomically claim one synthetic effect", async () => {
  const path = root(), effects = join(path, "effects.txt"), module = resolve(import.meta.dir, "../src/actions.ts");
  const code = `import {ActionStore} from ${JSON.stringify(module)}; import {appendFileSync} from 'node:fs'; const s=new ActionStore(${JSON.stringify(path)},'synthetic'); const r=s.submit({...${JSON.stringify(input())},requestId:crypto.randomUUID()}); if(r.ok && r.value.disposition!=='recipient-held'){const t=s.claim(r.value.action.id,'worker:'+process.pid); if(t.ok){const d=s.dispatch(t.value); if(d.ok)appendFileSync(${JSON.stringify(effects)},'effect\\n');}} s.close();`;
  const workers = Array.from({ length: 12 }, () => Bun.spawn([process.execPath, "--eval", code], { stdout: "pipe", stderr: "pipe" }));
  const exits = await Promise.all(workers.map(async worker => { const exit = await worker.exited; const stderr = await new Response(worker.stderr).text(); expect(stderr).toBe(""); return exit; }));
  expect(exits).toEqual(Array(12).fill(0)); expect(readFileSync(effects, "utf8")).toBe("effect\n");
  const final = store(path, "synthetic"); expect(value(final.list())).toHaveLength(1); expect(value(final.list())[0]!.state).toBe("inflight");
});
