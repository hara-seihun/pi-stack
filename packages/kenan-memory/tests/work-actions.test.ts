import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ActionStore, type ActionInput } from "../src/actions";
import { workActionRequest } from "../src/work-actions";

const input = (key: string, recipient = "+12025550123"): ActionInput => ({ intentKey: key, recipients: [recipient], transport: "browser", payload: { synthetic: true }, requestId: crypto.randomUUID(), threadId: "synthetic-work-thread" });
test("work view shares canonical recipient fencing but never exposes private or other-scope records", () => {
  const root = mkdtempSync(join(tmpdir(), "work-action-scope-")), store = new ActionStore(root, "synthetic-owner");
  try {
    const privateInput = input("private-purpose"); privateInput.payload = { privateFact: "synthetic-secret-marker" };
    const privateAction = store.submit(privateInput); if (!privateAction.ok) throw Error("fixture");
    const blocked = workActionRequest(store, "work:company", "submit", input("work-purpose"));
    expect(blocked).toEqual({ ok: false, error: "fenced", message: "External action blocked; contact purpose is unavailable in this work scope" });
    expect(JSON.stringify(blocked)).not.toContain(privateAction.value.action.id);
    expect(JSON.stringify(blocked)).not.toContain("synthetic-secret-marker");
    expect(workActionRequest(store, "work:company", "inspect", { id: privateAction.value.action.id })).toMatchObject({ ok: false, error: "not-found" });
    expect(workActionRequest(store, "work:company", "list", {})).toMatchObject({ ok: false, error: "fenced" });
    expect(workActionRequest(store, "work:company", "claim", { id: privateAction.value.action.id, actor: "forged" })).toMatchObject({ ok: false, error: "fenced" });
    store.linkRecipients(["+12025550124", "signal:synthetic-private-alias"], "verified-fixture");
    const workInput = input("synthetic-work", "+12025550124");
    const first: any = workActionRequest(store, "work:company", "submit", workInput); expect(first.ok).toBe(true);
    expect(first.value.action.recipients).toEqual(["tel:+12025550124"]);
    expect(JSON.stringify(first)).not.toContain("synthetic-private-alias");
    const again: any = workActionRequest(store, "work:company", "submit", { ...workInput, requestId: crypto.randomUUID() });
    expect(again.value.action.id).toBe(first.value.action.id);
    expect(workActionRequest(store, "work:other", "submit", { ...workInput, requestId: crypto.randomUUID() })).toMatchObject({ ok: false, error: "fenced" });
    const ticket: any = workActionRequest(store, "work:company", "claim", { id: first.value.action.id, actor: "work-worker" }); expect(ticket.ok).toBe(true);
    expect(workActionRequest(store, "work:company", "dispatch", { ticket: ticket.value })).toEqual({ ok: true, value: null });
    expect(workActionRequest(store, "work:company", "dispatch", { ticket: ticket.value })).toMatchObject({ ok: false, error: "fenced" });
    const done: any = workActionRequest(store, "work:company", "finish", { ticket: ticket.value, outcome: "uncertain", result: null, evidence: { kind: "operator-observation", reference: "fake", detail: "Synthetic lost provider receipt" } });
    expect(done.value.state).toBe("uncertain");
    const home = store.submit(input("personal-rephrase", "+12025550124")); expect(home.ok && home.value.disposition).toBe("recipient-held");
    expect(workActionRequest(store, "work:company", "reconcile", { id: first.value.action.id })).toMatchObject({ ok: false, error: "fenced" });
    const restarted = new ActionStore(root, "synthetic-owner");
    try { expect(workActionRequest(restarted, "work:company", "inspect", { id: first.value.action.id })).toMatchObject({ ok: true, value: { state: "uncertain" } }); } finally { restarted.close(); }
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
