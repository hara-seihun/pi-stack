import { expect, test } from "bun:test";
import { ActionStore } from "kenan-memory/actions";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { phoneIntent, reservePhoneAction, settlePhoneAction } from "./action-admission";
import { callBrief } from "./policy";

const brief = { requestId: "4208e41f-cafe-4bc5-991f-02dcb8f0f723", to: "+15555550123", purpose: "Confirm Tuesday appointment", shareableFacts: [], opening: "Hello", maxSeconds: 60 };
function fixture() { const path = mkdtempSync(join(tmpdir(), "phone-actions-")); const actions = new ActionStore(path, "fixture"); return { actions, path, close() { actions.close(); rmSync(path, { recursive: true, force: true }); } }; }
test("new worker/request UUID and changed wording cannot replay an accepted or uncertain contact", () => {
  const f = fixture();
  try {
    const first = reservePhoneAction(f.actions, brief); expect(first.ok).toBe(true); if (!first.ok) return;
    expect(f.actions.dispatch(first.value).ok).toBe(true);
    expect(settlePhoneAction(f.actions, first.value, "call1", "accepted", "provider1").ok).toBe(true);
    expect(reservePhoneAction(f.actions, { ...brief, requestId: "new-worker" })).toMatchObject({ ok: false, error: "action-already-owned", action: { id: first.value.id } });
    expect(f.actions.submit(phoneIntent({ ...brief, requestId: "exact-retry" }))).toMatchObject({ ok: true, value: { disposition: "existing", action: { id: first.value.id } } });
    expect(reservePhoneAction(f.actions, { ...brief, purpose: "Try again differently", requestId: "new-purpose" })).toMatchObject({ ok: false, error: "fenced", action: { id: first.value.id } });
    expect(reservePhoneAction(f.actions, { ...brief, opening: "Changed payload", requestId: "changed-payload" })).toMatchObject({ ok: false, error: "payload-conflict", action: { id: first.value.id } });
    const crossChannel = f.actions.submit({ intentKey: "text reminder", recipients: [brief.to], transport: "sms", payload: "hello", requestId: "sms1", threadId: "other-worker" });
    expect(crossChannel).toMatchObject({ ok: false, error: "fenced", action: { id: first.value.id } });
    expect(f.actions.list()).toMatchObject({ ok: true, value: [{ id: first.value.id }] });
  } finally { f.close(); }
});
test("20k-character purpose remains complete in payload with bounded stable identity and single contact custody", () => {
  const f = fixture();
  try {
    const thick = { ...brief, purpose: "Appointment detail. ".repeat(1000).padEnd(20_000, "x") };
    expect(thick.purpose).toHaveLength(20_000);
    expect(callBrief(thick)).toMatchObject({ ok: true, value: { purpose: thick.purpose } });
    expect(callBrief({ ...thick, purpose: "x".repeat(32_000) })).toMatchObject({ ok: false, error: "Approved call context exceeds the Voice instruction limit" });
    const intent = phoneIntent(thick);
    expect(intent.intentKey.length).toBeLessThan(1000);
    expect(intent.intentKey).not.toContain("appointment detail");
    expect(phoneIntent({ ...thick, purpose: `  ${thick.purpose.toUpperCase().replace(/ /g, "\t")}  ` }).intentKey).toBe(intent.intentKey);
    const first = reservePhoneAction(f.actions, thick);
    expect(first.ok).toBe(true); if (!first.ok) return;
    const retained = f.actions.inspect(first.value.id);
    expect(retained).toMatchObject({ ok: true, value: { payload: { purpose: thick.purpose } } });
    expect(f.actions.submit(phoneIntent({ ...thick, requestId: "thick-retry" }))).toMatchObject({ ok: true, value: { disposition: "existing", action: { id: first.value.id } } });
    expect(reservePhoneAction(f.actions, { ...thick, requestId: "thick-replay" })).toMatchObject({ ok: false, error: "action-already-owned" });
    expect(f.actions.submit(phoneIntent({ ...thick, opening: "Changed payload", requestId: "thick-conflict" }))).toMatchObject({ ok: false, error: "payload-conflict" });
    expect(f.actions.submit(phoneIntent({ ...thick, purpose: `${thick.purpose} Different purpose`, requestId: "thick-rephrase" }))).toMatchObject({ ok: false, error: "fenced" });
  } finally { f.close(); }
});
test("prepared canonical action can claim once; restart retains no replay after uncertainty", () => {
  const f = fixture();
  try {
    expect(f.actions.submit(phoneIntent(brief)).ok).toBe(true);
    const first = reservePhoneAction(f.actions, brief); expect(first.ok).toBe(true); if (!first.ok) return;
    expect(reservePhoneAction(f.actions, brief).ok).toBe(false);
    expect(settlePhoneAction(f.actions, first.value, "call1", "dispatching", null).ok).toBe(true);
    const reopened = new ActionStore(f.path, "fixture");
    try { expect(reservePhoneAction(reopened, { ...brief, requestId: "after-restart" }).ok).toBe(false); } finally { reopened.close(); }
  } finally { f.close(); }
});
test("operator follow-up transitions exact known effect and keeps repeated new request single shot", () => {
  const f = fixture();
  try {
    const first = reservePhoneAction(f.actions, brief); if (!first.ok) throw new Error(first.message);
    settlePhoneAction(f.actions, first.value, "prior-call", "accepted", "provider1");
    const next = { ...brief, requestId: "followup-request", followUpOf: "prior-call" };
    expect(reservePhoneAction(f.actions, { ...next, requestId: "unapproved-attempt" }).ok).toBe(false);
    const proof = { actionId: first.value.id, callId: "prior-call", reconciledAt: Date.now(), reason: "Operator reconciled and approved" };
    const followup = reservePhoneAction(f.actions, next, proof); expect(followup.ok).toBe(true);
    expect(reservePhoneAction(f.actions, next, proof).ok).toBe(false);
  } finally { f.close(); }
});
