import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionJournal } from "kenan-memory/journal";
import { ActionStore } from "kenan-memory/actions";
import type { MemoryClient, MemoryInput } from "kenan-memory/contract";
import { MessagingService, messagingConfig } from "./service";
import type { MessagingPlugin, MessagingPluginContext } from "./plugin";

const roots: string[] = [];
const services: MessagingService[] = [];
const actionStores: ActionStore[] = [];
function actionStore(root: string) { const store = new ActionStore(join(root, ".kenan-actions"), "fixture-alice"); actionStores.push(store); return store; }
function directory() { const root = mkdtempSync(join(tmpdir(), "pi-signal-service-")); roots.push(root); return root; }
const noJournal = new ActionJournal({ enabled: () => false });
async function setup(root = directory(), journal: Pick<ActionJournal, "begin" | "finish"> = noJournal) {
  let context!: MessagingPluginContext;
  let sends = 0;
  const plugin: MessagingPlugin = {
    icon: "signal", capabilities: { attachments: true, groups: true },
    async start(value) { context = value; value.status("ready", "Connected"); return { ok: true, value: undefined }; },
    async openConversation(target) { return { ok: true, value: { id: target, title: target, kind: "direct" } }; },
    async send() { sends++; return { ok: true, value: { externalId: `sent-${sends}`, timestamp: Date.now() } }; },
    async close() {},
  };
  const actions = actionStore(root);
  const service = new MessagingService(root, [{ id: "personal", plugin: "signal", label: "Personal" }], async () => plugin, undefined, undefined, journal, actions);
  services.push(service);
  await service.start();
  const conversation = await service.open("personal", "+15551230000");
  const chat = { id: conversation.externalId, title: conversation.title, kind: "direct" as const };
  return { service, context, plugin, conversation, chat, actions, sends: () => sends };
}
async function incoming(fixture: Awaited<ReturnType<typeof setup>>, id = "incoming", timestamp = 123, text = "hello") {
  await fixture.context.message({ id, conversation: fixture.chat, direction: "incoming", sender: "friend", text, timestamp, attachments: [] });
  return fixture.service.history(fixture.conversation.id).messages.find(message => message.externalId === id)!;
}
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.close()));
  for (const store of actionStores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("agent Signal custody", () => {
  test("profiles are explicit, unique Signal configurations", () => {
    expect(messagingConfig(undefined)).toEqual([]);
    expect(messagingConfig("[]")).toEqual([]);
    expect(messagingConfig('[{"id":"signal","plugin":"signal","label":"Signal"}]')).toHaveLength(1);
    for (const value of ['{}', '[{"id":"../escape","plugin":"signal","label":"x"}]', '[{"id":"x","plugin":"/tmp/plugin.ts","label":"x"}]', '[{"id":"x","plugin":"signal","label":"x"},{"id":"x","plugin":"signal","label":"x"}]']) expect(() => messagingConfig(value)).toThrow();
  });
  test("unknown backend variants cannot become known states", async () => {
    const fixture = await setup();
    expect(() => fixture.context.status("future" as any, "unsupported")).toThrow("Unsupported messaging backend status");
    expect(() => fixture.context.link({ status: "future" } as any)).toThrow("Unsupported messaging link status");
    await expect(fixture.context.message({ id: "invalid", conversation: fixture.chat, direction: "future" } as any)).rejects.toThrow("Unsupported messaging message direction");
    expect(fixture.service.history(fixture.conversation.id).messages).toEqual([]);
  });
  test("send receipts deduplicate concurrent, settled and restarted requests and refuse changed intent", async () => {
    const root = directory();
    const fixture = await setup(root);
    let release!: () => void;
    let dispatched = 0;
    fixture.plugin.send = () => { dispatched++; return new Promise(resolve => { release = () => resolve({ ok: true, value: { externalId: "sent", timestamp: 500 } }); }); };
    const input = { requestId: "send-receipt", text: "exact intent", attachmentIds: [] };
    const admitted = fixture.service.accept(fixture.conversation.id, input);
    expect(admitted.message.status).toBe("sending");
    expect(fixture.service.accept(fixture.conversation.id, input).settled).toBe(admitted.settled);
    expect(fixture.service.accept(fixture.conversation.id, { ...input, requestId: "concurrent-new-uuid" }).settled).toBe(admitted.settled);
    expect(() => fixture.service.accept(fixture.conversation.id, { ...input, text: "changed" })).toThrow("different message");
    await fixture.context.message({ id: "sent", conversation: fixture.chat, direction: "outgoing", sender: "self", text: input.text, timestamp: 500, attachments: [] });
    release();
    expect((await admitted.settled).status).toBe("sent");
    expect(fixture.service.history(fixture.conversation.id).messages).toHaveLength(1);
    expect(dispatched).toBe(1);
    await fixture.service.close();
    const restarted = await setup(root);
    expect((await restarted.service.send(fixture.conversation.id, input)).status).toBe("sent");
    expect(restarted.sends()).toBe(0);
  });
  test("uncertain sends and interrupted durable sends never replay", async () => {
    const root = directory();
    const fixture = await setup(root);
    let sends = 0;
    fixture.plugin.send = async () => { sends++; return { ok: false, error: { code: "unknown", message: "disconnected" } }; };
    const input = { requestId: "uncertain-send", text: "hello", attachmentIds: [] };
    expect((await fixture.service.send(fixture.conversation.id, input)).status).toBe("unknown");
    expect((await fixture.service.send(fixture.conversation.id, input)).status).toBe("unknown");
    expect(sends).toBe(1);
    await fixture.service.close();
    const db = new Database(join(root, "messages.sqlite3"));
    db.query("UPDATE messages SET status='sending' WHERE id=?").run(input.requestId);
    db.close();
    const restarted = await setup(root);
    expect((await restarted.service.send(fixture.conversation.id, input)).status).toBe("unknown");
    expect(restarted.sends()).toBe(0);
  });
  test("new UUIDs, rephrased purposes, aliases and cross-transport contacts cannot duplicate an unresolved effect", async () => {
    const fixture = await setup();
    fixture.context.sender({ id: "aci:friend", aliases: ["+15551230000"], name: "Friend" });
    const alias = await fixture.service.open("personal", "aci:friend");
    const input = { requestId: "first", intentKey: "arrange appointment", text: "Meet Tuesday", attachmentIds: [] };
    const first = await fixture.service.send(alias.id, input);
    expect(first.status).toBe("sent");
    expect((await fixture.service.send(fixture.conversation.id, { ...input, requestId: "another-uuid" })).id).toBe(first.id);
    expect(fixture.sends()).toBe(1);
    expect(() => fixture.service.accept(alias.id, { ...input, requestId: "rephrased", intentKey: "book visit", text: "Can we meet?" })).toThrow("unresolved");
    const cross = fixture.actions.submit({ intentKey: "call instead", recipients: ["tel:+15551230000"], transport: "telephone", payload: { purpose: "book visit" }, requestId: "call-new-id", threadId: "fixture" });
    expect(cross).toMatchObject({ ok: false, error: "fenced", action: { id: first.actionId, state: "succeeded" } });
  });
  test("learning a telephone alias after sending does not free the original Signal contact slot", async () => {
    const fixture = await setup();
    const unknown = await fixture.service.open("personal", "aci:late-friend");
    await fixture.service.send(unknown.id, { requestId: "before-alias", text: "hello", attachmentIds: [] });
    fixture.context.sender({ id: "aci:late-friend", aliases: ["+15551230000"], name: "Friend" });
    expect(() => fixture.service.accept(fixture.conversation.id, { requestId: "after-alias", text: "hello again", attachmentIds: [] })).toThrow("unresolved");
    expect(fixture.sends()).toBe(1);
    expect(fixture.actions.submit({ intentKey: "telephone-after-alias", recipients: ["tel:+15551230000"], transport: "telephone", payload: { purpose: "hello" }, requestId: "late-alias-call", threadId: "fixture" })).toMatchObject({ ok: false, error: "fenced" });
  });
  test("aliases revealing two unresolved effects hold every linked identity", async () => {
    const fixture = await setup();
    const unknown = await fixture.service.open("personal", "aci:conflict");
    const first = await fixture.service.send(unknown.id, { requestId: "aci-contact", text: "one", attachmentIds: [] });
    const second = await fixture.service.send(fixture.conversation.id, { requestId: "number-contact", text: "two", attachmentIds: [] });
    fixture.context.sender({ id: "aci:conflict", aliases: ["+15551230000"], name: "Friend" });
    for (const id of [first.actionId!, second.actionId!]) {
      const action = fixture.actions.inspect(id);
      if (!action.ok) throw new Error(action.message);
      expect(fixture.actions.reconcile(id, action.value.revision, "resolve-purpose", { kind: "operator-observation", reference: "fixture", detail: "Known effect accounted for" }, "fixture").ok).toBe(true);
    }
    expect(() => fixture.service.accept(fixture.conversation.id, { requestId: "after-conflict", text: "new", attachmentIds: [] })).toThrow("held");
    expect(fixture.sends()).toBe(2);
  });
  test("attachment UUIDs are not effect identity; immutable content is", async () => {
    const fixture = await setup();
    const upload = () => fixture.service.upload(new Request("http://local", { method: "PUT", body: "same bytes" }), fixture.conversation.id, "note.txt");
    const one = await upload();
    const first = await fixture.service.send(fixture.conversation.id, { requestId: "bytes-one", text: "", attachmentIds: [one.id] });
    const two = await upload();
    expect((await fixture.service.send(fixture.conversation.id, { requestId: "bytes-two", text: "", attachmentIds: [two.id] })).id).toBe(first.id);
    expect(fixture.sends()).toBe(1);
  });
  test("crash after provider effect before authority receipt remains fenced after restart", async () => {
    const root = directory();
    const fixture = await setup(root);
    const finish = fixture.actions.finish.bind(fixture.actions);
    fixture.actions.finish = () => ({ ok: false, error: "unavailable", message: "synthetic receipt crash" });
    const input = { requestId: "crashed", text: "effect happened", attachmentIds: [] };
    const sent = await fixture.service.send(fixture.conversation.id, input);
    expect(sent.error).toContain("Do not resend");
    expect(fixture.actions.inspect(sent.actionId!)).toMatchObject({ ok: true, value: { state: "inflight" } });
    fixture.actions.finish = finish;
    await fixture.service.close();
    const db = new Database(join(root, "messages.sqlite3"));
    db.query("UPDATE messages SET status='sending',external_id=NULL WHERE id=?").run(input.requestId);
    db.close();
    const restarted = await setup(root);
    expect((await restarted.service.send(fixture.conversation.id, { ...input, requestId: "new-after-crash" })).status).toBe("unknown");
    expect(() => restarted.service.accept(fixture.conversation.id, { ...input, requestId: "new-purpose", text: "rephrase" })).toThrow("unresolved");
    expect(restarted.sends()).toBe(0);
  });
  test("historical unknown native requests migrate without dispatch and fence new purposes", async () => {
    const root = directory();
    const fixture = await setup(root);
    await fixture.service.close();
    const db = new Database(join(root, "messages.sqlite3"));
    for (const [id, status, timestamp] of [["old-unknown", "unknown", 10], ["newer-confirmed", "sent", 20]] as const) {
      const input = { conversationId: fixture.conversation.id, text: id, attachmentIds: [] };
      db.query("INSERT INTO messages(id,conversation_id,direction,sender,text,timestamp,status,request_body) VALUES(?,?,'outgoing','You',?,?,?,?)").run(id, fixture.conversation.id, id, timestamp, status, JSON.stringify(input));
    }
    db.close();
    const restarted = await setup(root);
    expect(restarted.actions.list()).toMatchObject({ ok: true, value: [{ state: "uncertain", resolved: false }] });
    expect(() => restarted.service.accept(fixture.conversation.id, { requestId: "upgrade-new-id", text: "another purpose", attachmentIds: [] })).toThrow("unresolved");
    expect(restarted.sends()).toBe(0);
  });
  test("historical fenced imports preserve native outcomes and unknown holds independently of prior success", async () => {
    const root = directory();
    const fixture = await setup(root);
    const input = { requestId: "current-success", text: "confirmed original", attachmentIds: [] };
    const first = await fixture.service.send(fixture.conversation.id, input);
    await fixture.service.close();
    const db = new Database(join(root, "messages.sqlite3"));
    const historical = (id: string) => ({ conversationId: fixture.conversation.id, text: id, attachmentIds: [] });
    for (const [id, status] of [["historical-unknown", "unknown"], ["historical-failed", "failed"]] as const) {
      db.query("INSERT INTO messages(id,conversation_id,direction,sender,text,timestamp,status,request_body) VALUES(?,?,'outgoing','You',?,30,?,?)")
        .run(id, fixture.conversation.id, id, status, JSON.stringify(historical(id)));
    }
    const restarted = await setup(root);
    expect(db.query("SELECT request_id FROM messaging_action_refusals ORDER BY request_id").all()).toEqual([{ request_id: "historical-failed" }, { request_id: "historical-unknown" }]);
    expect(db.query("SELECT request_id FROM messaging_action_requests WHERE request_id LIKE 'historical-%'").all()).toEqual([]);
    db.close();
    expect((await restarted.service.send(fixture.conversation.id, { requestId: "historical-failed", text: "historical-failed", attachmentIds: [] })).status).toBe("failed");
    const prior = restarted.actions.inspect(first.actionId!);
    if (!prior.ok) throw new Error(prior.message);
    expect(restarted.actions.reconcile(first.actionId!, prior.value.revision, "resolve-purpose", { kind: "operator-observation", reference: "fixture", detail: "Original confirmed purpose is resolved, historical unknown is still unknown" }, "fixture").ok).toBe(true);
    expect(() => restarted.service.accept(fixture.conversation.id, { requestId: "after-prior-resolved", text: "new purpose", attachmentIds: [] })).toThrow("held");
    expect(restarted.sends()).toBe(0);
  });
  test("known authority receipt repairs a lost message projection without sending", async () => {
    const root = directory();
    const fixture = await setup(root);
    const input = { requestId: "known", text: "known result", attachmentIds: [] };
    await fixture.service.send(fixture.conversation.id, input);
    await fixture.service.close();
    const db = new Database(join(root, "messages.sqlite3"));
    db.query("UPDATE messages SET status='sending',external_id=NULL WHERE id=?").run(input.requestId);
    db.close();
    const restarted = await setup(root);
    const receipt = await restarted.service.send(fixture.conversation.id, { ...input, requestId: "new-known-id" });
    expect(receipt.status).toBe("sent");
    expect(receipt.externalId).toBe("sent-1");
    expect(restarted.sends()).toBe(0);
  });
  test("recipient holds and holds arriving during journal preparation prevent dispatch", async () => {
    const fixture = await setup();
    expect(fixture.actions.holdRecipient("tel:+15551230000", "stop contacting", "fixture").ok).toBe(true);
    expect(() => fixture.service.accept(fixture.conversation.id, { requestId: "held", text: "hello", attachmentIds: [] })).toThrow("held");
    expect(fixture.sends()).toBe(0);
    const root = directory();
    const actions = actionStore(root);
    const mid = await setup(root, { begin: () => { actions.holdRecipient("+15551230000", "hold during preparation", "fixture"); return null; }, finish: () => ({ ok: true }) });
    expect((await mid.service.send(mid.conversation.id, { requestId: "midhold", text: "hello", attachmentIds: [] })).status).toBe("unknown");
    expect(mid.sends()).toBe(0);
  });
  test("reaction receipts share a concurrent task, preserve exact outcomes and reject request reuse", async () => {
    const root = directory();
    const fixture = await setup(root);
    const target = await incoming(fixture);
    let release!: () => void;
    let reactions = 0;
    fixture.plugin.react = (_chat, author, emoji, remove) => {
      reactions++;
      expect(author).toEqual({ author: "friend", timestamp: 123 });
      expect([emoji, remove]).toEqual(["❤️", false]);
      return new Promise(resolve => { release = () => resolve({ ok: true, value: { timestamp: 130, sender: "self" } }); });
    };
    const pending = fixture.service.react(target.id, "❤️", false, "reaction-receipt");
    expect(fixture.service.react(target.id, "❤️", false, "reaction-receipt")).toBe(pending);
    expect(fixture.service.react(target.id, "❤️", false, "concurrent-new-reaction-uuid")).toBe(pending);
    expect(await fixture.service.react(target.id, "👍", false, "reaction-receipt")).toMatchObject({ ok: false, error: { code: "request_conflict" } });
    await Promise.resolve();
    release();
    const receipt = await pending;
    expect(receipt).toMatchObject({ ok: true, value: [{ emoji: "❤️", own: true }] });
    expect(await fixture.service.react(target.id, "❤️", false, "reaction-receipt")).toEqual(receipt);
    expect(await fixture.service.react(target.id, "❤️", false, "another-reaction-id")).toEqual(receipt);
    expect(reactions).toBe(1);
    await fixture.service.close();
    const restarted = await setup(root);
    restarted.plugin.react = async () => { throw new Error("must not dispatch"); };
    expect(await restarted.service.react(target.id, "❤️", false, "reaction-receipt")).toEqual(receipt);
  });
  test("known reaction authority receipt repairs crash-before-native-receipt without reacting again", async () => {
    const root = directory();
    const fixture = await setup(root);
    const target = await incoming(fixture);
    fixture.plugin.react = async () => ({ ok: true, value: { timestamp: 130, sender: "self" } });
    await fixture.service.react(target.id, "👍", false, "known-reaction");
    await fixture.service.close();
    const db = new Database(join(root, "messages.sqlite3"));
    db.exec("DELETE FROM messaging_reactions; UPDATE messaging_reaction_requests SET receipt=NULL");
    db.close();
    const restarted = await setup(root);
    let reactions = 0;
    restarted.plugin.react = async () => { reactions++; return { ok: true, value: { timestamp: 140, sender: "self" } }; };
    expect(await restarted.service.react(target.id, "👍", false, "known-reaction")).toMatchObject({ ok: true, value: [{ emoji: "👍" }] });
    expect(await restarted.service.react(target.id, "👍", false, "new-reaction-uuid")).toMatchObject({ ok: true });
    expect(reactions).toBe(0);
  });
  test("unknown, failed, thrown and interrupted reactions remain durable non-replayable receipts", async () => {
    const root = directory();
    const fixture = await setup(root);
    const target = await incoming(fixture);
    let dispatches = 0;
    for (const mode of ["failed", "throw"] as const) {
      fixture.plugin.react = async () => { dispatches++; if (mode === "throw") throw new Error("lost response"); return { ok: false, error: { code: mode, message: mode } }; };
      const receipt = await fixture.service.react(target.id, "👍", false, mode, mode);
      expect(receipt).toMatchObject({ ok: false, error: { code: mode === "throw" ? "unknown" : mode } });
      expect(await fixture.service.react(target.id, "👍", false, mode, mode)).toEqual(receipt);
    }
    expect(dispatches).toBe(2);
    await fixture.service.close();
    const db = new Database(join(root, "messages.sqlite3"));
    db.query("INSERT INTO messaging_reaction_requests(request_id,request_body) VALUES(?,?)").run("interrupted", JSON.stringify({ messageId: target.id, emoji: "👍", remove: false }));
    db.close();
    const restarted = await setup(root);
    let retries = 0;
    restarted.plugin.react = async () => { retries++; return { ok: true, value: { timestamp: 140, sender: "self" } }; };
    for (const requestId of ["failed", "throw", "interrupted"]) expect(await restarted.service.react(target.id, "👍", false, requestId, requestId === "interrupted" ? undefined : requestId)).toMatchObject({ ok: false });
    expect(await restarted.service.react(target.id, "👍", false, "interrupted")).toMatchObject({ ok: false, error: { code: "unknown" } });
    expect(retries).toBe(0);
  });
  test("HTTP followup is an accountable new effect, never an action-source bypass", async () => {
    const fixture = await setup();
    const input = { requestId: "original-contact", text: "original", attachmentIds: [] };
    const first = await fixture.service.send(fixture.conversation.id, input);
    const prior = fixture.actions.inspect(first.actionId!);
    if (!prior.ok) throw new Error(prior.message);
    const send = (body: unknown) => fixture.service.handle(new Request(`http://local/v1/agent-signal/conversations/${fixture.conversation.id}/messages`, { method: "POST", body: JSON.stringify(body) }));
    expect((await send({ ...input, requestId: "pretend-human", text: "new", source: "human" }))?.status).toBe(400);
    const refused = await send({ ...input, requestId: "different-purpose", text: "new" });
    expect(refused?.status).toBe(409);
    expect(await refused?.json()).toMatchObject({ code: "action_fenced", action: { id: first.actionId, state: "succeeded" } });
    const payloadConflict = await send({ ...input, requestId: "different-payload", text: "changed", intentKey: prior.value.intentKey });
    expect(payloadConflict?.status).toBe(409);
    expect(await payloadConflict?.json()).toMatchObject({ code: "action_payload-conflict", action: { id: first.actionId } });
    expect(fixture.sends()).toBe(1);
    const next = { requestId: "authorized-followup", text: "followup", attachmentIds: [], followup: { actionId: first.actionId!, revision: prior.value.revision, evidence: "Owner authorized this distinct followup after reading the delivered original" } };
    expect((await send(next))?.status).toBe(202);
    expect((await fixture.service.send(fixture.conversation.id, next)).status).toBe("sent");
    expect(fixture.actions.inspect(first.actionId!)).toMatchObject({ ok: true, value: { resolved: true } });
    expect(fixture.sends()).toBe(2);
  });
  test("reaction HTTP validates request IDs and uses the agent-only route", async () => {
    const fixture = await setup();
    const target = await incoming(fixture);
    let dispatches = 0;
    fixture.plugin.react = async () => { dispatches++; return { ok: true, value: { timestamp: 130, sender: "self" } }; };
    const react = (body: unknown) => fixture.service.handle(new Request(`http://local/v1/agent-signal/messages/${target.id}/reactions`, { method: "POST", body: JSON.stringify(body) }));
    expect((await react({ emoji: "👍" }))?.status).toBe(400);
    expect((await react({ requestId: "invalid", emoji: "plain text" }))?.status).toBe(400);
    expect((await react({ requestId: "invalid-remove", emoji: "👍", remove: "false" }))?.status).toBe(400);
    expect((await react({ requestId: "fake-source", emoji: "👍", source: "human" }))?.status).toBe(400);
    const body = { requestId: "http-reaction", emoji: "👍" };
    const confirmed = await react(body);
    expect(confirmed?.status).toBe(200);
    expect(await confirmed?.json()).toMatchObject({ ok: true, value: [{ emoji: "👍" }] });
    expect((await react(body))?.status).toBe(200);
    const rephrased = await react({ ...body, requestId: "new-reaction-purpose", intentKey: "new-purpose" });
    expect(rephrased?.status).toBe(409);
    expect(await rephrased?.json()).toMatchObject({ ok: false, error: { code: "action_fenced" } });
    const changed = await react({ ...body, requestId: "changed-reaction", emoji: "❤️" });
    expect(changed?.status).toBe(409);
    expect(await changed?.json()).toMatchObject({ ok: false, error: { code: "action_fenced" } });
    expect((await react({ ...body, remove: true }))?.status).toBe(409);
    expect(dispatches).toBe(1);
    expect(await fixture.service.handle(new Request("http://local/v1/messaging"))).toBeNull();
    expect((await fixture.service.handle(new Request("http://local/v1/agent-signal/calls")))?.status).toBe(404);
  });
  test("shutdown drains reactions admitted before closing and refuses new ones", async () => {
    const fixture = await setup();
    const target = await incoming(fixture);
    let release!: () => void;
    fixture.plugin.react = () => new Promise(resolve => { release = () => resolve({ ok: true, value: { timestamp: 140, sender: "self" } }); });
    const pending = fixture.service.react(target.id, "👍", false, "admitted");
    await Promise.resolve();
    const closing = fixture.service.close();
    expect(await fixture.service.react(target.id, "👍", false, "late")).toMatchObject({ ok: false, error: { code: "closed" } });
    release();
    expect(await pending).toMatchObject({ ok: true });
    await closing;
    expect(await fixture.service.react(target.id, "👍", false, "closed")).toMatchObject({ ok: false, error: { code: "closed" } });
  });
  test("reaction events precede messages, match group authors, and ignore older removals", async () => {
    const fixture = await setup();
    fixture.context.sender({ id: "friend", aliases: ["friend-number"], name: "Friend" });
    const group = { id: "group:g", title: "Group", kind: "group" as const };
    const event = { conversation: group, target: { author: "friend-number", timestamp: 777 }, account: "self", sender: "self", emoji: "👍", remove: false, timestamp: 780 };
    await fixture.context.reaction(event);
    await fixture.context.message({ id: "mine", conversation: group, direction: "outgoing", sender: "self", text: "mine", timestamp: 777, attachments: [] });
    await fixture.context.message({ id: "theirs", conversation: group, direction: "incoming", sender: "friend", text: "theirs", timestamp: 777, attachments: [] });
    const conversation = fixture.service.snapshot().conversations.find(item => item.externalId === group.id)!;
    const history = () => fixture.service.history(conversation.id).messages;
    expect(history()[0].reactions).toEqual([]);
    expect(history()[1].reactions).toMatchObject([{ emoji: "👍", own: true }]);
    await fixture.context.reaction({ ...event, remove: true, timestamp: 790 });
    await fixture.context.reaction(event);
    expect(history()[1].reactions).toEqual([]);
  });
  test("quotes and sender aliases resolve late targets and confirmed replies retain their exact intent", async () => {
    const fixture = await setup();
    fixture.context.self("self-number");
    fixture.context.sender({ id: "friend", aliases: ["friend-number"], name: "Friend" });
    await fixture.context.message({ id: "quote", conversation: fixture.chat, direction: "incoming", sender: "friend", text: "reply", timestamp: 200, attachments: [], reply: { author: "self-number", timestamp: 100, text: "original" } });
    expect(fixture.service.history(fixture.conversation.id).messages[0].reply?.messageId).toBeNull();
    await fixture.context.message({ id: "own", conversation: fixture.chat, direction: "outgoing", sender: "self-number", text: "original", timestamp: 100, attachments: [] });
    const history = fixture.service.history(fixture.conversation.id).messages;
    expect(history[0].reply).toMatchObject({ messageId: history[1].identity!.id, sender: { id: "self-number", own: true } });
    let quote: unknown;
    fixture.plugin.send = async (_chat, input) => { quote = input.reply; return { ok: false, error: { code: "unknown", message: "lost" } }; };
    const input = { requestId: "quoted-send", text: "answer", attachmentIds: [], replyTo: history[1].identity!.id };
    expect((await fixture.service.send(fixture.conversation.id, input)).reply).toMatchObject({ text: "original", messageId: history[1].identity!.id });
    expect(quote).toEqual({ author: "self-number", timestamp: 100, text: "original" });
    expect(() => fixture.service.send(fixture.conversation.id, { ...input, replyTo: undefined })).toThrow("different message");
  });
  test("history deduplicates incoming receipts, pages gaplessly and exposes revision changes", async () => {
    const fixture = await setup();
    for (let i = 0; i < 5; i++) await incoming(fixture, `received-${i}`, 100 + i, `message-${i}`);
    await incoming(fixture, "received-0", 100);
    const newest = fixture.service.history(fixture.conversation.id, undefined, 2);
    const older = fixture.service.history(fixture.conversation.id, newest.before!, 3);
    expect([...older.messages, ...newest.messages].map(message => message.externalId)).toEqual(["received-0", "received-1", "received-2", "received-3", "received-4"]);
    expect(fixture.service.history(fixture.conversation.id, undefined, 2, 102).messages).toHaveLength(3);
    expect(() => fixture.service.history(fixture.conversation.id, 1, 2, 102)).toThrow("cannot be combined");
    const initial = fixture.service.history(fixture.conversation.id);
    fixture.context.sender({ id: "friend", aliases: [], name: "Renamed" });
    const changed = fixture.service.changes(fixture.conversation.id, initial.revision);
    expect(changed.messages).toHaveLength(5);
    expect(changed.messages.every(message => message.senderName === "Renamed")).toBe(true);
    expect(fixture.service.changes(fixture.conversation.id, changed.revision).messages).toEqual([]);
  });
  test("attachments stay inside the conversation and confirmed bytes are immutable and range-readable", async () => {
    const fixture = await setup();
    const upload = await fixture.service.upload(new Request("http://local", { method: "PUT", body: "abcdef", headers: { "content-type": "image/png" } }), fixture.conversation.id, "image.png");
    const other = await fixture.service.open("personal", "other");
    const input = { requestId: "attachment-send", text: "", attachmentIds: [upload.id] };
    expect(() => fixture.service.send(other.id, input)).toThrow("Attachments must belong");
    const url = `http://local/v1/agent-signal/attachments/${upload.id}`;
    expect((await fixture.service.handle(new Request(url)))?.headers.get("cache-control")).toBe("private, no-store");
    expect((await fixture.service.send(fixture.conversation.id, input)).attachments).toEqual([upload]);
    expect(() => fixture.service.removeAttachment(upload.id)).toThrow("cannot be removed");
    const response = await fixture.service.handle(new Request(url, { headers: { range: "bytes=1-3" } }));
    expect(response?.status).toBe(206);
    expect(response?.headers.get("cache-control")).toContain("immutable");
    expect(await response?.text()).toBe("bcd");
    const draft = await fixture.service.upload(new Request("http://local", { method: "PUT", body: "draft" }), fixture.conversation.id, "draft");
    fixture.service.removeAttachment(draft.id);
    expect((await fixture.service.handle(new Request(`http://local/v1/agent-signal/attachments/${draft.id}`)))?.status).toBe(404);
  });
  test("presentation columns and avatar records survive restart unchanged and no longer update or escape the service", async () => {
    const root = directory();
    const first = await setup(root);
    await incoming(first);
    await first.service.close();
    const db = new Database(join(root, "messages.sqlite3"));
    db.query("UPDATE conversations SET current=1,unread=7 WHERE id=?").run(first.conversation.id);
    db.query("INSERT INTO messaging_avatars VALUES(?,?,?,?)").run("personal", "friend", "/private/picture", 1700);
    db.close();
    const second = await setup(root);
    await incoming(second, "fresh", 200);
    second.context.sender({ id: "friend", aliases: [], name: "Friend" });
    expect(second.service.snapshot().conversations[0]).not.toHaveProperty("current");
    expect(second.service.snapshot().conversations[0]).not.toHaveProperty("unread");
    expect(second.service.snapshot().conversations[0]).not.toHaveProperty("avatar");
    expect(second.service.history(first.conversation.id).messages[0]).not.toHaveProperty("senderAvatar");
    await second.service.close();
    const retained = new Database(join(root, "messages.sqlite3"));
    expect(retained.query("SELECT current,unread FROM conversations WHERE id=?").get(first.conversation.id)).toEqual({ current: 1, unread: 7 });
    expect(retained.query("SELECT path,updated_at FROM messaging_avatars").get()).toEqual({ path: "/private/picture", updated_at: 1700 });
    retained.close();
  });
  test("outgoing sends and reactions journal once across replays and refuse dispatch when attempts cannot persist", async () => {
    const items: MemoryInput[] = [];
    const client = { async request(request: any) { items.push(request.item); return { ok: true, value: request.item }; } } as MemoryClient;
    const journal = new ActionJournal({ directory: directory(), person: "alice", enabled: () => true, autoDrain: false, client });
    const fixture = await setup(directory(), journal);
    const input = { requestId: "journal-send", text: "hello", attachmentIds: [] };
    await fixture.service.send(fixture.conversation.id, input);
    await fixture.service.send(fixture.conversation.id, input);
    fixture.plugin.react = async () => ({ ok: true, value: { timestamp: Date.now(), sender: "self" } });
    const sent = await fixture.service.send(fixture.conversation.id, input);
    const prior = fixture.actions.inspect(sent.actionId!);
    if (!prior.ok) throw new Error(prior.message);
    const followup = { actionId: sent.actionId!, revision: prior.value.revision, evidence: "Authorized reaction as a new effect after confirmed message" };
    await fixture.service.react(input.requestId, "👍", false, "journal-react", undefined, followup);
    await fixture.service.react(input.requestId, "👍", false, "journal-react", undefined, followup);
    await journal.drain();
    expect(items.filter(item => item.source.action === "personal.message:confirmed")).toHaveLength(1);
    expect(items.filter(item => item.source.action === "personal.reaction:confirmed")).toHaveLength(1);
    const brokenPath = join(directory(), "file");
    writeFileSync(brokenPath, "not a directory");
    const broken = await setup(directory(), new ActionJournal({ directory: brokenPath, enabled: () => true, person: "alice", autoDrain: false }));
    expect((await broken.service.send(broken.conversation.id, input)).status).toBe("failed");
    expect(broken.sends()).toBe(0);
    const target = await incoming(broken);
    let reactions = 0;
    broken.plugin.react = async () => { reactions++; return { ok: true, value: { timestamp: 130, sender: "self" } }; };
    expect(await broken.service.react(target.id, "👍", false, "broken-journal")).toMatchObject({ ok: false, error: { code: "journal_unavailable" } });
    expect(reactions).toBe(0);
  });
  test("default journal always records locally with a fake memory drain", async () => {
    const root = directory();
    const fixture = await setup(root);
    await fixture.service.close();
    const drain = ActionJournal.prototype.drain;
    ActionJournal.prototype.drain = () => Promise.resolve({ ok: true });
    try {
      const service = new MessagingService(root, [{ id: "personal", plugin: "signal", label: "Personal" }], async () => fixture.plugin, undefined, undefined, undefined, actionStore(root));
      services.push(service);
      await service.start();
      await service.send(fixture.conversation.id, { requestId: "always-journal", text: "local durable receipt", attachmentIds: [] });
      const files = readdirSync(join(root, "action-journal"));
      expect(files.some(file => file.endsWith(".attempted.json"))).toBe(true);
      expect(files.some(file => file.endsWith(".confirmed.json"))).toBe(true);
      const receipt = JSON.parse(readFileSync(join(root, "action-journal", files.find(file => file.endsWith(".confirmed.json"))!), "utf8"));
      expect(receipt.text).toContain("local durable receipt");
    } finally { ActionJournal.prototype.drain = drain; }
  });
  test("agent provisioning relaunches the newly linked profile and validates device names", async () => {
    const root = directory();
    let context!: MessagingPluginContext;
    let linked = false;
    let launches = 0;
    const service = new MessagingService(root, [{ id: "signal", plugin: "signal", label: "Signal" }], async () => ({
      icon: "signal", linkable: true, capabilities: { attachments: false, groups: false },
      async start(value) { context = value; launches++; value.status(linked ? "ready" : "unconfigured", linked ? "Connected" : "Not linked"); return { ok: true, value: undefined }; },
      async startLink(name) { expect(name).toBe("Agent"); return { ok: true, value: { status: "waiting", uri: "sgnl://linkdevice?uuid=123", deviceName: name, account: null, error: null, updatedAt: Date.now() } }; },
      async cancelLink() { return { status: "cancelled", uri: null, deviceName: "Agent", account: null, error: null, updatedAt: Date.now() }; },
      async openConversation(target) { return { ok: true, value: { id: target, title: target, kind: "direct" } }; },
      async send() { throw new Error("unused"); }, async close() {},
    }), undefined, undefined, noJournal, actionStore(root));
    services.push(service);
    await service.start();
    await expect(service.startLink("signal", "\u0000")).rejects.toThrow("Device name");
    expect(await service.startLink("signal", "Agent")).toMatchObject({ status: "waiting" });
    linked = true;
    context.link({ status: "linked", account: "+15551230000", uri: null, deviceName: "Agent", error: null, updatedAt: Date.now() });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(launches).toBe(2);
    expect(service.snapshot().backends[0].status).toBe("ready");
  });
});
