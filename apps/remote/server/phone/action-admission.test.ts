import { expect, test } from "bun:test";
import { ActionStore } from "kenan-memory/actions";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { phoneIntent, reservePhoneAction, settlePhoneAction } from "./action-admission";

const brief = { requestId: "4208e41f-cafe-4bc5-991f-02dcb8f0f723", to: "+15555550123", purpose: "Confirm Tuesday appointment", shareableFacts: [], opening: "Hello", maxSeconds: 60 };
function fixture() { const path = mkdtempSync(join(tmpdir(), "phone-actions-")); const actions = new ActionStore(path, "fixture"); return { actions, path, close() { actions.close(); rmSync(path, { recursive: true, force: true }); } }; }
test("new worker/request UUID and changed wording cannot replay an accepted or uncertain contact", () => {
  const f = fixture();
  try {
    const first = reservePhoneAction(f.actions, brief); expect(first.ok).toBe(true); if (!first.ok) return;
    expect(f.actions.dispatch(first.value).ok).toBe(true);
    expect(settlePhoneAction(f.actions, first.value, "call1", "accepted", "provider1").ok).toBe(true);
    expect(reservePhoneAction(f.actions, { ...brief, requestId: "new-worker" }).ok).toBe(false);
    expect(reservePhoneAction(f.actions, { ...brief, purpose: "Try again differently", requestId: "new-purpose" }).ok).toBe(false);
    const crossChannel = f.actions.submit({ intentKey: "text reminder", recipients: [brief.to], transport: "sms", payload: "hello", requestId: "sms1", threadId: "other-worker" });
    expect(crossChannel.ok && crossChannel.value.disposition).toBe("recipient-held");
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
