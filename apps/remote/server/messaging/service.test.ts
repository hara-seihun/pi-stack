import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessagingService, messagingConfig } from "./service";
import { messagingRoot, createMessagingService } from "./index";
import type { MessagingPlugin, MessagingPluginContext } from "./plugin";

const roots: string[] = [];
const services: MessagingService[] = [];
function directory() { const path = mkdtempSync(join(tmpdir(), "pi-messaging-")); roots.push(path); return path; }
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function setup(root = directory(), onChange?: () => void) {
  let context!: MessagingPluginContext;
  let sends = 0;
  let callStarts = 0;
  let callAudioClosed = 0;
  let remoteAudio: (frame: Uint8Array) => void = () => {};
  const microphoneAudio: Uint8Array[] = [];
  let mode: "ok" | "unknown" | "failed" = "ok";
  const plugin: MessagingPlugin = {
    icon: "test-chat",
    capabilities: { attachments: true, groups: true, calls: true },
    calls: {
      async start(peer) { callStarts++; return { ok: true, value: { externalId: "18446744073709551610", peer, direction: "outgoing", state: "ringing_outgoing", reason: null } }; },
      async accept(externalId) { return { ok: true, value: { externalId, peer: conversation.externalId, direction: "incoming", state: "connecting", reason: null } }; },
      async hangup() { return { ok: true, value: undefined }; },
      async audio() {
        return { ok: true, value: {
          onRemote(handler) { remoteAudio = handler; },
          write(frame) { microphoneAudio.push(frame.slice()); },
          async close() { callAudioClosed++; },
        } };
      },
    },
    async start(value) { context = value; value.status("ready", "Connected"); return { ok: true, value: undefined }; },
    async openConversation(target) { return { ok: true, value: { id: target, title: target, kind: "direct" } }; },
    async send() { sends++; return mode === "ok" ? { ok: true, value: { externalId: `sent-${sends}`, timestamp: Date.now() } } : { ok: false, error: { code: mode, message: mode } }; },
    async close() {},
  };
  const service = new MessagingService(root, [{ id: "personal", label: "Personal Signal", plugin: "test" }], async () => plugin, onChange);
  services.push(service);
  await service.start();
  const conversation = await service.open("personal", "+15551230000");
  return {
    service, conversation, context, plugin,
    setMode(value: typeof mode) { mode = value; }, sends: () => sends,
    callStarts: () => callStarts, callAudioClosed: () => callAudioClosed,
    microphoneAudio, sendRemoteAudio(frame: Uint8Array) { remoteAudio(frame); },
  };
}

describe("messaging custody", () => {
  test("reaction events precede messages, survive restart and replay, and use the same outbound state", async () => {
    const root = directory();
    let changes = 0;
    const { service, context, conversation, plugin } = await setup(root, () => changes++);
    context.sender({ id: 'friend', aliases: ['friend-number'], name: 'Friend' });
    const target = { author: 'friend-number', timestamp: 123 };
    const event = { conversation: { id: conversation.externalId, title: conversation.title, kind: 'direct' as const }, target, account: 'self', sender: 'self', emoji: '👍', remove: false, timestamp: 130 };
    await context.reaction(event);
    expect(service.history(conversation.id).messages).toHaveLength(0);
    const original = { id: 'incoming', conversation: event.conversation, direction: 'incoming' as const, sender: 'friend', text: 'hello', timestamp: 123, attachments: [] };
    await context.message(original);
    const id = service.history(conversation.id).messages[0].id;
    expect(service.history(conversation.id).messages[0]).toMatchObject({ identity: { id: `messaging/${id}`, timestamp: 123, sender: { id: 'friend', name: 'Friend' } }, reactions: [{ emoji: '👍', sender: { id: 'self' }, timestamp: 130, own: true }] });
    const count = changes;
    await context.reaction(event);
    expect(changes).toBe(count);
    await context.reaction({ ...event, remove: true, timestamp: 140 });
    await context.reaction(event);
    expect(service.history(conversation.id).messages[0].reactions).toEqual([]);
    plugin.react = async (_conversation, target, emoji, remove) => {
      expect(target).toEqual({ author: 'friend', timestamp: 123 });
      expect(remove).toBe(false);
      expect(emoji).toBe('❤️');
      return { ok: true, value: { timestamp: 150, sender: 'self' } };
    };
    expect(await service.react('unknown', '❤️', false)).toMatchObject({ ok: false, error: { code: 'message_not_found' } });
    expect(await service.react(id, '❤️', false)).toMatchObject({ ok: true, value: [{ emoji: '❤️', own: true }] });
    await service.close();
    const restarted = await setup(root);
    expect(restarted.service.history(conversation.id).messages[0].reactions).toMatchObject([{ emoji: '❤️', own: true }]);
  });
  test("Signal quotes resolve late originals by author and timestamp, including own sends, across restart", async () => {
    const root = directory();
    const { service, context, conversation } = await setup(root);
    context.self('self-number');
    context.sender({ id: 'friend-uuid', aliases: ['friend-number'], name: 'Friend' });
    const chat = { id: conversation.externalId, title: conversation.title, kind: 'direct' as const };
    await context.message({ id: 'quote-first', conversation: chat, direction: 'incoming', sender: 'friend-uuid', text: 'answer', timestamp: 200, attachments: [], reply: { author: 'self-number', timestamp: 100, text: 'original' } });
    const first = service.history(conversation.id).messages[0];
    expect(first.reply).toMatchObject({ messageId: null, text: 'original', sender: { id: 'self-number' }, timestamp: 100 });
    await context.message({ id: 'other', conversation: chat, direction: 'incoming', sender: 'friend-uuid', text: 'wrong', timestamp: 100, attachments: [] });
    expect(service.history(conversation.id).messages[0].reply?.messageId).toBeNull();
    await context.message({ id: 'mine', conversation: chat, direction: 'outgoing', sender: 'self-number', text: 'original', timestamp: 100, attachments: [] });
    const resolved = service.history(conversation.id).messages;
    expect(resolved[0].reply?.messageId).toBe(`messaging/${resolved[2].id}`);
    const count = resolved.length;
    await context.message({ id: 'quote-first', conversation: chat, direction: 'incoming', sender: 'friend-uuid', text: 'answer', timestamp: 200, attachments: [], reply: { author: 'self-number', timestamp: 100, text: 'original' } });
    expect(service.history(conversation.id).messages).toHaveLength(count);
    await service.close();
    const restarted = await setup(root);
    expect(restarted.service.history(conversation.id).messages[0].reply).toEqual(resolved[0].reply);
  });
  test("send replies quote confirmed stored targets and preserve their intent on uncertain receipts", async () => {
    const { service, context, conversation, plugin, sends } = await setup();
    context.sender({ id: 'friend-uuid', aliases: ['friend-number'], name: 'Friend' });
    const chat = { id: conversation.externalId, title: conversation.title, kind: 'direct' as const };
    await context.message({ id: 'original', conversation: chat, direction: 'incoming', sender: 'friend-number', text: 'exact quote', timestamp: 123, attachments: [] });
    const target = service.history(conversation.id).messages[0];
    const input = { requestId: 'reply-send', text: 'response', attachmentIds: [], replyTo: target.identity!.id };
    let sentReply: unknown;
    plugin.send = async (_conversation, value) => { sentReply = value.reply; return { ok: false, error: { code: 'unknown', message: 'uncertain' } }; };
    const accepted = service.accept(conversation.id, input);
    expect(accepted.message.reply).toMatchObject({ messageId: target.identity!.id, text: 'exact quote', sender: { id: 'friend-uuid', name: 'Friend' } });
    expect(sentReply).toEqual({ author: 'friend-uuid', timestamp: 123, text: 'exact quote' });
    expect((await accepted.settled).status).toBe('unknown');
    expect(await service.send(conversation.id, input)).toMatchObject({ status: 'unknown', reply: { messageId: target.identity!.id } });
    expect(() => service.send(conversation.id, { ...input, replyTo: 'messaging/other' })).toThrow('different message');
    expect(() => service.send(conversation.id, { ...input, replyTo: undefined })).toThrow('different message');
    expect(() => service.send(conversation.id, { ...input, requestId: 'missing', replyTo: 'messaging/missing' })).toThrow('confirmed message');
    expect(() => service.send(conversation.id, { ...input, requestId: 'wrong-transport', replyTo: 'pi/session/id' })).toThrow('messaging message');
    const other = await service.open('personal', 'another-contact');
    expect(() => service.send(other.id, { ...input, requestId: 'other-conversation' })).toThrow('confirmed message');
    expect(sends()).toBe(0);
  });
  test("shutdown rejects new reactions and drains an admitted reaction before closing storage", async () => {
    const { service, context, conversation, plugin } = await setup();
    await context.message({ id: 'react-target', conversation: { id: conversation.externalId, title: conversation.title, kind: 'direct' }, direction: 'incoming', sender: 'friend', text: 'hello', timestamp: 123, attachments: [] });
    const id = service.history(conversation.id).messages[0].id;
    let release!: () => void;
    const backendDone = new Promise<void>(resolve => { release = resolve; });
    plugin.react = async () => {
      await backendDone;
      return { ok: true, value: { timestamp: 130, sender: 'self' } };
    };
    const pending = service.react(id, '❤️', false);
    const closing = service.close();
    expect(await service.react(id, '❤️', false)).toMatchObject({ ok: false, error: { code: 'closed' } });
    let closed = false;
    void closing.then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    expect(await pending).toMatchObject({ ok: true, value: [{ emoji: '❤️' }] });
    await closing;
    expect(closed).toBe(true);
    expect(await service.react(id, '❤️', false)).toMatchObject({ ok: false, error: { code: 'closed' } });
  });
  test("local outgoing identity resolves to the linked account before its Signal sync", async () => {
    const { service, context, conversation } = await setup();
    context.self('+12025550100');
    const sent = service.accept(conversation.id, { requestId: 'own-send', text: 'hello', attachmentIds: [] });
    expect(sent.message.identity).toBeUndefined();
    expect((await sent.settled).identity).toMatchObject({ id: 'messaging/own-send', sender: { id: '+12025550100' } });
  });
  test("group reactions match target author as well as timestamp and keep peer ownership", async () => {
    const { service, context } = await setup();
    const group = { id: 'group:abc', title: 'Group', kind: 'group' as const };
    await context.reaction({ conversation: group, target: { author: 'other', timestamp: 777 }, account: 'self', sender: 'friend', emoji: '🔥', remove: false, timestamp: 781 });
    await context.message({ id: 'mine', conversation: group, direction: 'outgoing', sender: 'self', text: 'mine', timestamp: 777, attachments: [] });
    await context.message({ id: 'theirs', conversation: group, direction: 'incoming', sender: 'other', text: 'theirs', timestamp: 777, attachments: [] });
    const id = service.snapshot().conversations.find(item => item.externalId === group.id)!.id;
    const messages = service.history(id).messages;
    expect(messages[0].reactions).toEqual([]);
    expect(messages[1].reactions).toMatchObject([{ emoji: '🔥', sender: { id: 'friend' }, own: false }]);
  });
  test("historical message previews are scoped to stored text and refuse loopback targets", async () => {
    const { service, context, conversation } = await setup();
    await context.message({ id: "preview", conversation: { id: conversation.externalId, title: conversation.title, kind: "direct" }, direction: "incoming", sender: "Friend", text: "Look at http://127.0.0.1:8899/secret. Again http://127.0.0.1:8899/secret", timestamp: 123, attachments: [] });
    const id = service.history(conversation.id).messages[0].id;
    const response = await service.handle(new Request(`http://local/v1/messaging/messages/${id}/link-previews`));
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ previews: [{ url: "http://127.0.0.1:8899/secret", title: "127.0.0.1", description: null, imageUrl: null, siteName: null }] });
    const missing = await service.handle(new Request("http://local/v1/messaging/messages/not-stored/link-previews"));
    expect(missing?.status).toBe(404);
  });
  test("stored sender identities resolve on discovery, survive restart, and rename without touching history", async () => {
    const root = directory();
    const { service, context, conversation } = await setup(root);
    const sender = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const number = '+12025550101';
    const incoming = { id: 'original', conversation: { id: conversation.externalId, title: conversation.title, kind: 'group' as const }, direction: 'incoming' as const, sender, text: 'hello', timestamp: 123, attachments: [] };
    await context.message(incoming);
    await context.message({ ...incoming, id: 'by-number', sender: number });
    service.closeConversation(conversation.id);
    const original = service.history(conversation.id).messages;
    const named = (name: string) => original.map(message => ({ ...message, senderName: name, identity: { ...message.identity!, sender: { id: message.sender, name } } }));
    const state = service.snapshot().conversations;
    expect(original[0].senderName).toBeUndefined();
    const version = service.snapshot().version;
    context.sender({ id: sender, aliases: [number], name: 'Known Contact' });
    expect(service.snapshot().version).toBeGreaterThan(version);
    expect(service.history(conversation.id).messages).toEqual(named('Known Contact'));
    expect(service.snapshot().conversations).toEqual(state);
    const namedVersion = service.snapshot().version;
    context.sender({ id: sender, aliases: [number], name: 'Known Contact' });
    expect(service.snapshot().version).toBe(namedVersion);
    context.sender({ id: sender, aliases: [], name: 'New Name' });
    await context.message(incoming);
    expect(service.history(conversation.id).messages).toEqual(named('New Name'));
    expect(service.snapshot().conversations).toEqual(state);
    await service.close();
    const restarted = await setup(root);
    expect(restarted.service.history(conversation.id).messages).toEqual(named('New Name'));
    restarted.context.sender({ id: sender, aliases: [], name: null });
    expect(restarted.service.history(conversation.id).messages).toEqual(original);
    expect(restarted.sends()).toBe(0);
  });
  test("sender names stay inside their backend and person's store", async () => {
    const contexts = new Map<string, MessagingPluginContext>();
    const configs = ['first', 'second'].map(id => ({ id, plugin: 'test', label: id }));
    const service = new MessagingService(directory(), configs, async config => ({
      icon: 'test-chat', capabilities: { attachments: false, groups: true, calls: false },
      async start(context) { contexts.set(config.id, context); return { ok: true, value: undefined }; },
      async openConversation() { throw new Error('not used'); },
      async send() { throw new Error('not used'); },
      async close() {},
    }));
    services.push(service);
    await service.start();
    const incoming = { id: 'same-message', conversation: { id: 'group', title: 'Group', kind: 'group' as const }, direction: 'incoming' as const, sender: 'same-uuid', text: 'hello', timestamp: 123, attachments: [] };
    for (const context of contexts.values()) await context.message(incoming);
    contexts.get('first')!.sender({ id: incoming.sender, aliases: [], name: 'First Contact' });
    const names = () => Object.fromEntries(service.snapshot().conversations.map(conversation => [conversation.backendId, service.history(conversation.id).messages[0].senderName]));
    expect(names()).toEqual({ first: 'First Contact', second: undefined });
    contexts.get('second')!.sender({ id: incoming.sender, aliases: [], name: 'Second Contact' });
    expect(names()).toEqual({ first: 'First Contact', second: 'Second Contact' });
    const otherPerson = await setup();
    await otherPerson.context.message(incoming);
    const otherGroup = otherPerson.service.snapshot().conversations.find(conversation => conversation.externalId === 'group')!;
    expect(otherPerson.service.history(otherGroup.id).messages[0].senderName).toBeUndefined();
  });
  test("current chats close without deleting history and reopen only for fresh incoming messages or explicit opens", async () => {
    let changes = 0;
    const fixture = await setup(directory(), () => changes++);
    const { service, context, conversation } = fixture;
    const current = () => service.snapshot().conversations.find(item => item.id === conversation.id)!;
    expect(current().current).toBe(true);
    const message = { id: "incoming", conversation: { id: conversation.externalId, title: conversation.title, kind: "direct" as const }, direction: "incoming" as const, sender: "Friend", text: "hello", timestamp: Date.now(), attachments: [] };
    await context.message(message);
    const response = await service.handle(new Request(`http://local/v1/messaging/conversations/${conversation.id}`, { method: "DELETE" }));
    expect(response?.status).toBe(200);
    expect(current().current).toBe(false);
    expect(service.history(conversation.id).messages).toHaveLength(1);
    const closedVersion = service.snapshot().version;
    const closedChanges = changes;
    await context.message(message);
    service.closeConversation(conversation.id);
    expect(service.snapshot().version).toBe(closedVersion);
    expect(changes).toBe(closedChanges);
    await context.message({ ...message, id: "linked-send", direction: "outgoing" });
    expect(current().current).toBe(false);
    expect(service.snapshot().version).toBeGreaterThan(closedVersion);
    await context.message({ ...message, id: "fresh-incoming" });
    expect(current().current).toBe(true);
    service.closeConversation(conversation.id);
    context.status("error", "Offline");
    expect((await service.open("personal", conversation.externalId)).current).toBe(true);
    expect(fixture.sends()).toBe(0);
  });
  test("directory discovery stays outside current chats and unchanged reads or discovery do not notify", async () => {
    let changes = 0;
    const { service, context, conversation } = await setup(directory(), () => changes++);
    context.conversation({ id: "directory", title: "Directory contact", kind: "direct" });
    expect(service.snapshot().conversations.find(item => item.externalId === "directory")?.current).toBe(false);
    expect(service.snapshot().backends[0].icon).toBe("test-chat");
    const snapshot = service.snapshot();
    const count = changes;
    context.conversation({ id: "directory", title: "Directory contact", kind: "direct" });
    context.status("ready", "Connected");
    service.markRead(conversation.id);
    expect(service.snapshot().version).toBe(snapshot.version);
    expect(changes).toBe(count);
    context.conversation({ id: "directory", title: "Renamed", kind: "direct" });
    expect(service.snapshot().version).toBeGreaterThan(snapshot.version);
    expect(changes).toBeGreaterThan(count);
    expect((await service.open("personal", "directory")).current).toBe(true);
  });
  test("only message activity ranks discovered, renamed and opened directory entries", async () => {
    const { service, context, conversation } = await setup();
    const contact = { id: "directory", title: "Directory contact", kind: "direct" as const };
    context.conversation(contact);
    const entry = () => service.snapshot().conversations.find(item => item.externalId === contact.id)!;
    expect(entry().updatedAt).toBe(0);
    expect(conversation.updatedAt).toBe(0);
    const message = { id: "latest", conversation: contact, direction: "incoming" as const, sender: "Friend", text: "hello", timestamp: 200, attachments: [] };
    await context.message(message);
    await context.message({ ...message, id: "older", timestamp: 100 });
    await context.message({ ...message, timestamp: 300 });
    context.conversation({ ...contact, title: "Renamed" });
    context.conversation({ id: "new-contact", title: "New contact", kind: "direct" });
    await service.open("personal", "new-contact");
    service.markRead(entry().id);
    expect(entry()).toMatchObject({ title: "Renamed", updatedAt: 200, unread: 0 });
    expect(service.snapshot().conversations[0].id).toBe(entry().id);
    expect(service.snapshot().conversations.filter(item => item.id !== entry().id).every(item => item.updatedAt === 0)).toBe(true);
  });
  test("new sends open current chats while receipt replay and late confirmation preserve a close", async () => {
    const fixture = await setup();
    const { service, conversation, plugin } = fixture;
    service.closeConversation(conversation.id);
    let confirm!: () => void;
    plugin.send = () => new Promise(resolve => { confirm = () => resolve({ ok: true, value: { externalId: "delayed", timestamp: Date.now() } }); });
    const input = { requestId: "delayed-send", text: "hi", attachmentIds: [] };
    const pending = service.send(conversation.id, input);
    expect(service.snapshot().conversations[0].current).toBe(true);
    expect(service.snapshot().conversations[0].updatedAt).toBe(service.history(conversation.id).messages[0].timestamp);
    expect(service.snapshot().conversations[0].updatedAt).toBeGreaterThan(0);
    service.closeConversation(conversation.id);
    expect(service.send(conversation.id, input)).toBe(pending);
    confirm();
    await pending;
    expect(service.snapshot().conversations[0].current).toBe(false);
    await service.send(conversation.id, input);
    expect(service.snapshot().conversations[0].current).toBe(false);
  });
  test("existing stores migrate history once and retain closed state across restart", async () => {
    const root = directory();
    const db = new Database(join(root, "messages.sqlite3"));
    db.exec(`CREATE TABLE conversations(id TEXT PRIMARY KEY,backend_id TEXT NOT NULL,external_id TEXT NOT NULL,title TEXT NOT NULL,kind TEXT NOT NULL,updated_at INTEGER NOT NULL,unread INTEGER NOT NULL DEFAULT 0,UNIQUE(backend_id,external_id));
      CREATE TABLE messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,conversation_id TEXT NOT NULL REFERENCES conversations(id),external_id TEXT,direction TEXT NOT NULL,sender TEXT NOT NULL,text TEXT NOT NULL,timestamp INTEGER NOT NULL,status TEXT NOT NULL,error TEXT,request_body TEXT);
      INSERT INTO conversations VALUES('history','personal','history','Friend','direct',1,0),('directory','personal','directory','Contact','direct',1,0);
      INSERT INTO messages(id,conversation_id,direction,sender,text,timestamp,status) VALUES('stored','history','incoming','aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee','hello',1,'received');`);
    db.close();
    const first = await setup(root);
    first.context.sender({ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', aliases: [], name: 'Known Profile' });
    expect(first.service.history('history').messages[0]).toMatchObject({ sender: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', senderName: 'Known Profile' });
    expect(first.service.snapshot().conversations.find(item => item.id === "history")?.current).toBe(true);
    expect(first.service.snapshot().conversations.find(item => item.id === "directory")?.current).toBe(false);
    first.service.closeConversation("history");
    const version = first.service.snapshot().version;
    await first.service.close();
    const second = await setup(root);
    expect(second.service.snapshot().conversations.find(item => item.id === "history")?.current).toBe(false);
    expect(second.service.history("history").messages).toHaveLength(1);
    expect(second.service.history('history').messages[0].senderName).toBe('Known Profile');
    expect(second.service.snapshot().version).toBeGreaterThan(version);
  });
  test("restart repairs discovery timestamps from message history without changing closed or unread state", async () => {
    const root = directory();
    const first = await setup(root);
    const contact = { id: "received", title: "Friend", kind: "direct" as const };
    for (const timestamp of [200, 100]) await first.context.message({ id: String(timestamp), conversation: contact, direction: "incoming", sender: "Friend", text: "hello", timestamp, attachments: [] });
    const received = first.service.snapshot().conversations.find(item => item.externalId === contact.id)!;
    first.service.closeConversation(received.id);
    first.context.conversation({ id: "empty", title: "No messages", kind: "direct" });
    first.plugin.send = async () => ({ ok: true, value: { externalId: "confirmed", timestamp: 300 } });
    await first.service.send(first.conversation.id, { requestId: "sent", text: "hello", attachmentIds: [] });
    expect(first.service.snapshot().conversations.find(item => item.id === first.conversation.id)?.updatedAt).toBe(300);
    const version = first.service.snapshot().version;
    await first.service.close();
    const db = new Database(join(root, "messages.sqlite3"));
    db.exec("UPDATE conversations SET updated_at=999999;");
    db.query("INSERT INTO messages(id,conversation_id,direction,sender,text,timestamp,status) VALUES('interrupted',?,'outgoing','You','pending',400,'sending')").run(first.conversation.id);
    db.close();
    const second = await setup(root);
    const snapshot = second.service.snapshot();
    expect(snapshot.conversations.find(item => item.externalId === "empty")).toMatchObject({ updatedAt: 0, current: false });
    expect(snapshot.conversations.find(item => item.id === received.id)).toMatchObject({ updatedAt: 200, current: false, unread: 2 });
    expect(snapshot.conversations.find(item => item.id === first.conversation.id)?.updatedAt).toBe(400);
    expect(second.service.history(first.conversation.id).messages.at(-1)?.status).toBe("unknown");
    expect(snapshot.version).toBeGreaterThan(version);
    await second.service.close();
    const third = await setup(root);
    expect(third.service.snapshot().conversations).toEqual(snapshot.conversations);
    expect(third.sends()).toBe(0);
  });
  test("send acceptance and confirmation cannot demote newer received activity", async () => {
    const { service, context, conversation, plugin } = await setup();
    const timestamp = Date.now() + 10_000;
    await context.message({ id: "future", conversation: { id: conversation.externalId, title: conversation.title, kind: "direct" }, direction: "incoming", sender: "Friend", text: "hello", timestamp, attachments: [] });
    let confirm!: () => void;
    plugin.send = () => new Promise(resolve => { confirm = () => resolve({ ok: true, value: { externalId: "confirmed", timestamp: 100 } }); });
    const pending = service.send(conversation.id, { requestId: "send", text: "hello", attachmentIds: [] });
    expect(service.snapshot().conversations[0].updatedAt).toBe(timestamp);
    confirm();
    await pending;
    expect(service.snapshot().conversations[0].updatedAt).toBe(timestamp);
  });
  test("a send receipt survives repeat requests and restart without sending twice", async () => {
    const root = directory();
    const first = await setup(root);
    const input = { requestId: "one", text: "hello", attachmentIds: [] };
    expect((await first.service.send(first.conversation.id, input)).status).toBe("sent");
    expect((await first.service.send(first.conversation.id, input)).status).toBe("sent");
    expect(first.sends()).toBe(1);
    expect(() => first.service.send(first.conversation.id, { ...input, text: "different" })).toThrow("different message");
    await first.service.close();
    const second = await setup(root);
    expect((await second.service.send(first.conversation.id, input)).status).toBe("sent");
    expect(second.sends()).toBe(0);
  });
  test("an uncertain send cannot be retried by repeating its request", async () => {
    const fixture = await setup(); fixture.setMode("unknown");
    const input = { requestId: "uncertain", text: "hello", attachmentIds: [] };
    expect((await fixture.service.send(fixture.conversation.id, input)).status).toBe("unknown");
    fixture.setMode("ok");
    expect((await fixture.service.send(fixture.conversation.id, input)).status).toBe("unknown");
    expect(fixture.sends()).toBe(1);
  });
  test("attachments stay with their conversation; confirmed failed sends permit explicit resend", async () => {
    const fixture = await setup();
    const other = await fixture.service.open("personal", "+15551230001");
    const attachment = await fixture.service.upload(new Request("http://local/upload", { method: "POST", body: "hello", headers: { "content-type": "text/plain" } }), fixture.conversation.id, "note.txt");
    expect(() => fixture.service.send(other.id, { requestId: "wrong", text: "", attachmentIds: [attachment.id] })).toThrow("conversation");
    fixture.setMode("failed");
    expect((await fixture.service.send(fixture.conversation.id, { requestId: "failed", text: "", attachmentIds: [attachment.id] })).status).toBe("failed");
    expect(() => fixture.service.removeAttachment(attachment.id)).not.toThrow();
    expect(fixture.service.history(fixture.conversation.id).messages[0].attachments[0].id).toBe(attachment.id);
    fixture.setMode("ok");
    expect((await fixture.service.send(fixture.conversation.id, { requestId: "resend", text: "", attachmentIds: [attachment.id] })).status).toBe("sent");
    expect(fixture.service.history(fixture.conversation.id).messages.map(message => message.attachments.length)).toEqual([1, 1]);
    expect(() => fixture.service.removeAttachment(attachment.id)).toThrow("cannot be removed");
  });
  test("image attachments download explicitly but remain inline for previews", async () => {
    const fixture = await setup();
    const attachment = await fixture.service.upload(new Request("http://local/upload", { method: "POST", body: "png", headers: { "content-type": "image/png" } }), fixture.conversation.id, "photo.png");
    const path = `/v1/messaging/attachments/${attachment.id}`;
    const preview = (await fixture.service.handle(new Request(`http://local${path}`)))!;
    expect(preview.headers.get("content-disposition")).toStartWith("inline;");
    const download = (await fixture.service.handle(new Request(`http://local${path}?download=1`)))!;
    expect(download.headers.get("content-disposition")).toStartWith("attachment;");
    expect(download.headers.get("content-disposition")).toContain("photo.png");
  });
  test("a sent-sync event arriving before send confirmation merges into its durable request", async () => {
    const fixture = await setup();
    fixture.plugin.send = async (conversation, message) => {
      await fixture.context.message({ id: "sync-first", conversation, direction: "outgoing", sender: "You", text: message.text, timestamp: 1234, attachments: message.attachments });
      return { ok: true, value: { externalId: "sync-first", timestamp: 1234 } };
    };
    const attachment = await fixture.service.upload(new Request("http://local/upload", { method: "POST", body: "bytes" }), fixture.conversation.id, "file.txt");
    const sent = await fixture.service.send(fixture.conversation.id, { requestId: "sync-race", text: "hi", attachmentIds: [attachment.id] });
    const history = fixture.service.history(fixture.conversation.id).messages;
    expect(history.length).toBe(1);
    expect(sent.requestId).toBe("sync-race");
    expect(sent.attachments.map(item => item.id)).toEqual([attachment.id]);
  });
  test("incoming receipts deduplicate, read markers clear, histories page without starting agents", async () => {
    const fixture = await setup();
    for (let index = 0; index < 4; index++) {
      const message = { id: String(index), conversation: { id: "+15551230000", title: "Friend", kind: "direct" as const }, direction: "incoming" as const, sender: "Friend", text: String(index), timestamp: Date.now(), attachments: [] };
      await fixture.context.message(message); await fixture.context.message(message);
    }
    expect(fixture.service.snapshot().conversations[0].unread).toBe(4);
    const page = fixture.service.history(fixture.conversation.id, undefined, 2);
    expect(page.messages.map(message => message.text)).toEqual(["2", "3"]);
    expect(fixture.service.history(fixture.conversation.id, page.before!, 2).messages.map(message => message.text)).toEqual(["0", "1"]);
    fixture.service.markRead(fixture.conversation.id);
    expect(fixture.service.snapshot().conversations[0].unread).toBe(0);
    expect(fixture.sends()).toBe(0);
  });
  test("since history includes every recent message in seq order and keeps older cursor paging gapless", async () => {
    const fixture = await setup();
    const conversation = { id: fixture.conversation.externalId, title: "Friend", kind: "direct" as const };
    const receive = (index: number, timestamp: number) => fixture.context.message({ id: String(index), conversation, direction: "incoming" as const, sender: "Friend", text: String(index), timestamp, attachments: [] });
    for (let index = 0; index < 6; index++) await receive(index, 999);
    for (let index = 6; index < 132; index++) await receive(index, index === 112 ? 998 : 1000 + index);

    const page = fixture.service.history(fixture.conversation.id, undefined, 50, 1006);
    expect(page.messages.map(message => Number(message.text))).toEqual(Array.from({ length: 126 }, (_, index) => index + 6));
    expect(page.before).toBe(7);
    expect(fixture.service.snapshot().conversations[0].unread).toBe(132);
    const older = fixture.service.history(fixture.conversation.id, page.before!, 50);
    expect(older.messages.map(message => Number(message.text))).toEqual([0, 1, 2, 3, 4, 5]);
    expect(older.before).toBeNull();
    expect(fixture.service.history(fixture.conversation.id, undefined, 2).messages.map(message => message.text)).toEqual(["130", "131"]);
    expect(fixture.service.history(fixture.conversation.id, undefined, 3, 999999).messages.map(message => message.text)).toEqual(["129", "130", "131"]);
    expect(fixture.service.history(fixture.conversation.id, undefined, 3, 0).messages).toHaveLength(132);
  });
  test("history rejects invalid since values and conflicting cursors through both service and HTTP", async () => {
    const fixture = await setup();
    const id = fixture.conversation.id;
    for (const since of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => fixture.service.history(id, undefined, 60, since)).toThrow("Invalid message timestamp");
    }
    expect(() => fixture.service.history(id, 2, 60, 0)).toThrow("before and since cannot be combined");
    for (const query of ["since=", "since=bad", "since=-1", "since=%20", "since=1e3", "before=2&since=0"]) {
      const response = (await fixture.service.handle(new Request(`http://local/v1/messaging/conversations/${id}/messages?${query}`)))!;
      expect(response.status).toBe(400);
    }
    const response = (await fixture.service.handle(new Request(`http://local/v1/messaging/conversations/${id}/messages?since=0`)))!;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ messages: [], before: null });
  });
  test("contact and group pictures reach the inbox, message headers and an image route that reads the type from the bytes", async () => {
    const root = directory();
    const fixture = await setup(root);
    const pictures = join(root, "pictures"); mkdirSync(pictures);
    const jpeg = join(pictures, "profile-uuid"); writeFileSync(jpeg, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]));
    const png = join(pictures, "group-g"); writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
    const plain = join(pictures, "profile-text"); writeFileSync(plain, "not an image");
    const sender = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    await fixture.context.message({ id: "m", conversation: { id: fixture.conversation.externalId, title: fixture.conversation.title, kind: "direct" }, direction: "incoming", sender: "+12025550101", text: "hi", timestamp: 5, attachments: [] });
    expect(fixture.service.history(fixture.conversation.id).messages[0].senderAvatar).toBeUndefined();
    expect(fixture.service.snapshot().conversations[0].avatar).toBeNull();
    const before = fixture.service.snapshot().version;
    fixture.context.sender({ id: sender, aliases: ["+12025550101"], name: "Friend", avatar: { path: jpeg, updatedAt: 1700 } });
    fixture.context.conversation({ id: fixture.conversation.externalId, title: fixture.conversation.title, kind: "direct", avatar: { path: jpeg, updatedAt: 1700 } });
    fixture.context.conversation({ id: "group:g", title: "Group", kind: "group", avatar: { path: png, updatedAt: 1800 } });
    fixture.context.conversation({ id: "group:plain", title: "Plain", kind: "group", avatar: { path: plain, updatedAt: 1900 } });
    expect(fixture.service.snapshot().version).toBeGreaterThan(before);
    // The message's sender arrived by number; the picture is found through the alias.
    expect(fixture.service.history(fixture.conversation.id).messages[0].senderAvatar).toBe(1700);
    const byTitle = Object.fromEntries(fixture.service.snapshot().conversations.map(item => [item.title, item.avatar]));
    expect(byTitle).toEqual({ [fixture.conversation.title]: 1700, Group: 1800, Plain: 1900 });
    const unchanged = fixture.service.snapshot().version;
    fixture.context.conversation({ id: "group:g", title: "Group", kind: "group", avatar: { path: png, updatedAt: 1800 } });
    fixture.context.conversation({ id: "group:g", title: "Group", kind: "group" });
    expect(fixture.service.snapshot().version).toBe(unchanged);
    const fetchAvatar = (id: string) => fixture.service.handle(new Request(`http://local/v1/messaging/backends/personal/avatars/${encodeURIComponent(id)}`));
    const person = (await fetchAvatar("+12025550101"))!;
    expect(person.status).toBe(200);
    expect(person.headers.get("content-type")).toBe("image/jpeg");
    expect(person.headers.get("cache-control")).toContain("max-age");
    const group = (await fetchAvatar("group:g"))!;
    expect(group.headers.get("content-type")).toBe("image/png");
    expect((await fetchAvatar("group:plain"))!.status).toBe(404);
    expect((await fetchAvatar("+19999999999"))!.status).toBe(404);
    fixture.context.conversation({ id: "group:g", title: "Group", kind: "group", avatar: null });
    expect((await fetchAvatar("group:g"))!.status).toBe(404);
    expect(fixture.service.snapshot().conversations.find(item => item.title === "Group")!.avatar).toBeNull();
    await fixture.service.close();
    const restarted = await setup(root);
    expect(restarted.service.snapshot().conversations.find(item => item.title === fixture.conversation.title)!.avatar).toBe(1700);
  });
  test("separate account roots do not expose one another's conversations or files", async () => {
    const a = await setup(); const b = await setup();
    const attachment = await a.service.upload(new Request("http://local/upload", { method: "POST", body: "private" }), a.conversation.id, "secret.txt");
    expect(() => b.service.history(a.conversation.id)).toThrow("not found");
    const response = await b.service.handle(new Request(`http://local/v1/messaging/attachments/${attachment.id}`));
    expect(response?.status).toBe(404);
  });
  test("unencrypted persons cannot initialize messaging storage; symlink escapes fail", async () => {
    const root = directory(); const data = join(root, "data"); mkdirSync(data);
    expect(() => messagingRoot(data, root, false)).toThrow("encrypted PiStack account");
    const endpoint = createMessagingService(data, root, false);
    const response = await endpoint.handle(new Request("http://local/v1/messaging"));
    const snapshot = endpoint.snapshot();
    expect(await response!.json()).toEqual(snapshot);
    expect(snapshot.version).toBeGreaterThanOrEqual(1);
    expect(snapshot.backends[0].status).toBe("unconfigured");
    expect(snapshot.backends[0].icon).toBe("signal");
    const outside = directory(); symlinkSync(outside, join(data, "messaging"));
    expect(() => messagingRoot(data, root, true)).toThrow("outside");
  });
  test("an account owner links a backend from the app and the service reconnects it", async () => {
    let context!: MessagingPluginContext;
    let starts = 0;
    let linked = false;
    const waiting = { status: "waiting" as const, uri: "sgnl://linkdevice?uuid=u&pub_key=k", qr: "<svg></svg>", deviceName: "Martine phone", account: null, error: null, updatedAt: 1 };
    const service = new MessagingService(directory(), [{ id: "personal", plugin: "test", label: "Personal Signal" }], async () => ({
      icon: "test-chat",
      capabilities: { attachments: false, groups: false, calls: false },
      linkable: true,
      async start(value) {
        starts++; context = value;
        if (linked) value.status("ready", "Signal linked as +12025550100");
        else value.status("unconfigured", "Signal is not linked yet");
        return { ok: true, value: undefined };
      },
      async startLink(deviceName) { return { ok: true, value: { ...waiting, deviceName } }; },
      async cancelLink() { return { ...waiting, status: "cancelled", uri: null, qr: null }; },
      async openConversation(target) { return { ok: true, value: { id: target, title: target, kind: "direct" } }; },
      async send() { return { ok: false, error: { code: "unconfigured", message: "not linked" } }; },
      async close() {},
    }));
    services.push(service);
    await service.start();
    expect(service.snapshot().backends[0]).toMatchObject({ linkable: true, status: "unconfigured", link: null });

    const response = await service.handle(new Request("http://local/v1/messaging/backends/personal/link", { method: "POST", body: JSON.stringify({ deviceName: "Martine phone" }), headers: { "content-type": "application/json" } }));
    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual({ link: { ...waiting, deviceName: "Martine phone" } });
    expect(service.snapshot().backends[0].link).toMatchObject({ status: "waiting", uri: waiting.uri });

    const version = service.snapshot().version;
    linked = true;
    context.link({ ...waiting, status: "linked", uri: null, qr: null, account: "+12025550100" });
    await service.handle(new Request("http://local/v1/messaging"));
    expect(service.snapshot().version).toBeGreaterThan(version);
    await Bun.sleep(20);
    expect(starts).toBe(2);
    expect(service.snapshot().backends[0]).toMatchObject({ status: "ready", link: { status: "linked", account: "+12025550100" } });

    const refused = await service.handle(new Request("http://local/v1/messaging/backends/personal/link", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }));
    expect(refused?.status).toBe(409);
    const missing = await service.handle(new Request("http://local/v1/messaging/backends/other/link", { method: "POST", body: "{}" }));
    expect(missing?.status).toBe(404);
  });
  test("linking is refused for backends that do not support it, and cancelling records no account", async () => {
    const fixture = await setup();
    const response = await fixture.service.handle(new Request("http://local/v1/messaging/backends/personal/link", { method: "POST", body: "{}" }));
    expect(response?.status).toBe(409);
    expect(fixture.service.snapshot().backends[0].linkable).toBe(false);
    const cancel = await fixture.service.handle(new Request("http://local/v1/messaging/backends/personal/link", { method: "DELETE" }));
    expect(cancel?.status).toBe(409);
  });
  test("profile IDs are unique and cannot become filesystem paths", () => {
    expect(() => messagingConfig(JSON.stringify([{ id: "../other", plugin: "test", label: "Other" }]))).toThrow("require");
    expect(() => messagingConfig(JSON.stringify([{ id: "a", plugin: "test", label: "A" }, { id: "a", plugin: "test", label: "B" }]))).toThrow("Duplicate");
  });
});

describe("Signal calls", () => {
  test("placing a call is idempotent and rejects groups or a second live call with stable codes", async () => {
    const fixture = await setup();
    const place = (conversationId: string, requestId: string) => fixture.service.handle(new Request("http://local/v1/messaging/backends/personal/calls", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId, requestId }),
    }));
    const first = await place(fixture.conversation.id, "call-request");
    const firstBody = await first!.json();
    expect(first?.status).toBe(200);
    expect((await (await place(fixture.conversation.id, "call-request"))!.json()).call.id).toBe(firstBody.call.id);
    expect(fixture.callStarts()).toBe(1);

    const other = await fixture.service.open("personal", "+15551230001");
    const concurrent = await place(other.id, "other-call");
    expect(concurrent?.status).toBe(409);
    expect(await concurrent!.json()).toMatchObject({ code: "call_in_progress" });

    fixture.context.conversation({ id: "group:test", title: "Group", kind: "group" });
    const group = fixture.service.snapshot().conversations.find(value => value.externalId === "group:test")!;
    await fixture.service.hangupCall(firstBody.call.id);
    expect((await (await place(fixture.conversation.id, "call-request"))!.json()).call).toMatchObject({ id: firstBody.call.id, state: "ended" });
    const groupResponse = await place(group.id, "group-call");
    expect(groupResponse?.status).toBe(409);
    expect(await groupResponse!.json()).toMatchObject({ code: "calls_direct_only" });
  });

  test("a backend without call support answers with calls_unsupported", async () => {
    const service = new MessagingService(directory(), [{ id: "messages", plugin: "test", label: "Messages" }], async () => ({
      icon: "test-chat", capabilities: { attachments: false, groups: false, calls: false },
      async start(context) { context.status("ready", "Connected"); return { ok: true, value: undefined }; },
      async openConversation(target) { return { ok: true, value: { id: target, title: target, kind: "direct" } }; },
      async send() { return { ok: false, error: { code: "failed", message: "not sent" } }; },
      async close() {},
    }));
    services.push(service);
    await service.start();
    const conversation = await service.open("messages", "+15551230002");
    const response = await service.handle(new Request("http://local/v1/messaging/backends/messages/calls", {
      method: "POST", body: JSON.stringify({ conversationId: conversation.id, requestId: "unsupported-call" }),
    }));
    expect(response?.status).toBe(501);
    expect(await response!.json()).toMatchObject({ code: "calls_unsupported" });
  });

  test("incoming calls resolve and open their direct conversation", async () => {
    const fixture = await setup();
    fixture.context.sender({ id: "peer-uuid", aliases: ["+15551239999"], name: "Caller" });
    fixture.context.call({ externalId: "9007199254740999", peer: "+15551239999", direction: "incoming", state: "ringing_incoming", reason: null });
    const call = fixture.service.snapshot().calls[0]!;
    const conversation = fixture.service.snapshot().conversations.find(value => value.id === call.conversationId)!;
    expect(call).toMatchObject({ peer: "+15551239999", peerName: "Caller", direction: "incoming", state: "ringing_incoming" });
    expect(conversation).toMatchObject({ externalId: "peer-uuid", current: true });
  });

  test("mute drops microphone frames and a new audio socket silently displaces the old one", async () => {
    const fixture = await setup();
    const call = await fixture.service.placeCall("personal", fixture.conversation.id, "audio-call");
    fixture.context.call({ externalId: "18446744073709551610", peer: fixture.conversation.externalId, direction: "outgoing", state: "connected", reason: null });
    await Bun.sleep(1);
    const oldSocket = fixture.service.openCallAudio(call.id)!;
    const newSocket = fixture.service.openCallAudio(call.id)!;
    const oldRemote: Uint8Array[] = [];
    const newRemote: Uint8Array[] = [];
    let oldEnded = 0;
    let newEnded = 0;
    expect(oldSocket.attach(frame => oldRemote.push(frame), () => oldEnded++)).toBe(true);
    expect(newSocket.attach(frame => newRemote.push(frame), () => newEnded++)).toBe(true);
    oldSocket.detach();
    expect(fixture.service.snapshot().calls[0].muted).toBe(false);

    const frame = new Uint8Array(1_920).fill(7);
    fixture.sendRemoteAudio(frame);
    expect(oldRemote).toHaveLength(0);
    expect(newRemote).toEqual([frame]);
    oldSocket.receive(frame);
    newSocket.receive(new Uint8Array(100));
    expect(fixture.microphoneAudio).toHaveLength(0);
    fixture.service.muteCall(call.id, true);
    newSocket.receive(frame);
    expect(fixture.microphoneAudio).toHaveLength(0);
    fixture.service.muteCall(call.id, false);
    newSocket.receive(frame);
    expect(fixture.microphoneAudio).toEqual([frame]);

    fixture.context.call({ externalId: "18446744073709551610", peer: fixture.conversation.externalId, direction: "outgoing", state: "ended", reason: "remote_hangup" });
    await Bun.sleep(1);
    expect(oldEnded).toBe(0);
    expect(newEnded).toBe(1);
    expect(fixture.callAudioClosed()).toBe(1);
    newSocket.receive(frame);
    expect(fixture.microphoneAudio).toHaveLength(1);
  });

  test("a backend error ends the live call and releases audio", async () => {
    const fixture = await setup();
    const call = await fixture.service.placeCall("personal", fixture.conversation.id, "failed-backend-call");
    fixture.context.call({ externalId: "18446744073709551610", peer: fixture.conversation.externalId, direction: "outgoing", state: "connected", reason: null });
    await Bun.sleep(1);
    const socket = fixture.service.openCallAudio(call.id)!;
    let ended = 0;
    socket.attach(() => {}, () => ended++);
    fixture.context.status("error", "signal-cli exited");
    await Bun.sleep(1);
    expect(fixture.service.snapshot().calls[0]).toMatchObject({ id: call.id, state: "ended", reason: "backend_error", error: "signal-cli exited" });
    expect(fixture.service.openCallAudio(call.id)).toBeNull();
    expect(fixture.callAudioClosed()).toBe(1);
    expect(ended).toBe(1);
  });
});

describe("messaging resilience", () => {
  test("a backend that fails to start recovers on its own instead of waiting for a handoff", async () => {
    let attempts = 0;
    const plugin: MessagingPlugin = {
      icon: "test-chat",
      capabilities: { attachments: false, groups: false, calls: false },
      async start(value) {
        if (++attempts === 1) {
          value.status("error", "signal-cli exited before startup completed");
          return { ok: false, error: { code: "connection", message: "signal-cli exited before startup completed" } };
        }
        value.status("ready", "Connected");
        return { ok: true, value: undefined };
      },
      async openConversation(target) { return { ok: true, value: { id: target, title: target, kind: "direct" } }; },
      async send() { return { ok: false, error: { code: "failed", message: "not sent" } }; },
      async close() {},
    };
    const service = new MessagingService(directory(), [{ id: "personal", label: "Personal Signal", plugin: "test" }], async () => plugin, undefined, { baseMs: 10, maxMs: 20, unconfiguredMs: 10 });
    services.push(service);
    await service.start();
    expect(service.snapshot().backends[0].status).toBe("error");
    for (let wait = 0; wait < 60 && service.snapshot().backends[0].status !== "ready"; wait++) await Bun.sleep(20);
    expect(service.snapshot().backends[0].status).toBe("ready");
    expect(attempts).toBeGreaterThan(1);
  });
});
