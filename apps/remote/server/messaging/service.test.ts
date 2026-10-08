import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionJournal } from "kenan-memory/journal";
import type { MemoryClient, MemoryInput } from "kenan-memory/contract";
import { MessagingService, messagingConfig } from "./service";
import type { MessagingPlugin, MessagingPluginContext } from "./plugin";

const roots: string[] = [];
const services: MessagingService[] = [];
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
  const service = new MessagingService(root, [{ id: "personal", plugin: "signal", label: "Personal" }], async () => plugin, undefined, undefined, journal);
  services.push(service);
  await service.start();
  const conversation = await service.open("personal", "+15551230000");
  const chat = { id: conversation.externalId, title: conversation.title, kind: "direct" as const };
  return { service, context, plugin, conversation, chat, sends: () => sends };
}
async function incoming(fixture: Awaited<ReturnType<typeof setup>>, id = "incoming", timestamp = 123, text = "hello") {
  await fixture.context.message({ id, conversation: fixture.chat, direction: "incoming", sender: "friend", text, timestamp, attachments: [] });
  return fixture.service.history(fixture.conversation.id).messages.find(message => message.externalId === id)!;
}
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.close()));
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
    expect(await fixture.service.react(target.id, "👍", false, "reaction-receipt")).toMatchObject({ ok: false, error: { code: "request_conflict" } });
    await Promise.resolve();
    release();
    const receipt = await pending;
    expect(receipt).toMatchObject({ ok: true, value: [{ emoji: "❤️", own: true }] });
    expect(await fixture.service.react(target.id, "❤️", false, "reaction-receipt")).toEqual(receipt);
    expect(reactions).toBe(1);
    await fixture.service.close();
    const restarted = await setup(root);
    restarted.plugin.react = async () => { throw new Error("must not dispatch"); };
    expect(await restarted.service.react(target.id, "❤️", false, "reaction-receipt")).toEqual(receipt);
  });
  test("unknown, failed, thrown and interrupted reactions remain durable non-replayable receipts", async () => {
    const root = directory();
    const fixture = await setup(root);
    const target = await incoming(fixture);
    let dispatches = 0;
    for (const mode of ["unknown", "failed", "throw"] as const) {
      fixture.plugin.react = async () => { dispatches++; if (mode === "throw") throw new Error("lost response"); return { ok: false, error: { code: mode, message: mode } }; };
      const receipt = await fixture.service.react(target.id, "👍", false, mode);
      expect(receipt).toMatchObject({ ok: false, error: { code: mode === "throw" ? "unknown" : mode } });
      expect(await fixture.service.react(target.id, "👍", false, mode)).toEqual(receipt);
    }
    expect(dispatches).toBe(3);
    await fixture.service.close();
    const db = new Database(join(root, "messages.sqlite3"));
    db.query("INSERT INTO messaging_reaction_requests(request_id,request_body) VALUES(?,?)").run("interrupted", JSON.stringify({ messageId: target.id, emoji: "👍", remove: false }));
    db.close();
    const restarted = await setup(root);
    let retries = 0;
    restarted.plugin.react = async () => { retries++; return { ok: true, value: { timestamp: 140, sender: "self" } }; };
    for (const requestId of ["unknown", "failed", "throw", "interrupted"]) expect(await restarted.service.react(target.id, "👍", false, requestId)).toMatchObject({ ok: false });
    expect(await restarted.service.react(target.id, "👍", false, "interrupted")).toMatchObject({ ok: false, error: { code: "unknown" } });
    expect(retries).toBe(0);
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
    const body = { requestId: "http-reaction", emoji: "👍" };
    const confirmed = await react(body);
    expect(confirmed?.status).toBe(200);
    expect(await confirmed?.json()).toMatchObject({ ok: true, value: [{ emoji: "👍" }] });
    expect((await react(body))?.status).toBe(200);
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
    await fixture.service.react(input.requestId, "👍", false, "journal-react");
    await fixture.service.react(input.requestId, "👍", false, "journal-react");
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
      const service = new MessagingService(root, [{ id: "personal", plugin: "signal", label: "Personal" }], async () => fixture.plugin);
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
    }), undefined, undefined, noJournal);
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
