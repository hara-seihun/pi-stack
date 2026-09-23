import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isReactionEmoji, messageReference, parseMessageReference } from "./message-protocol";
import { nativeMessageExists, PiReactions, reactToMessage, type ReactionTransports } from "./reactions";
import { deriveTranscriptItems } from "./transcript-items";

const owner = { id: "person", name: "Hara" };
const target = { transport: "pi" as const, sessionId: "thread", messageId: "native-id" };

test("references preserve native identifiers and emoji validation accepts composed emoji", () => {
  for (const ref of [target, { transport: "messaging" as const, messageId: "id/with:%" }, { transport: "slack" as const, workspace: "T123", channel: "C123", messageId: "1234.000005" }]) {
    expect(parseMessageReference(messageReference(ref))).toEqual(ref);
  }
  for (const value of ["pi/a", "pi/a/b/c", "pi/%ZZ/b", "pi//b", "pi/a/%00", "unscoped-id"]) expect(parseMessageReference(value)).toBeNull();
  for (const value of ["❤️", "👍🏽", "🇬🇧", "1️⃣", "👩‍💻"]) expect(isReactionEmoji(value)).toBe(true);
  for (const value of ["", "hello", "👍👍", "<react>❤️</react>"]) expect(isReactionEmoji(value)).toBe(false);
});

test("one dispatcher validates before routing and preserves transport errors", async () => {
  const calls: unknown[][] = [];
  const transports: ReactionTransports = {
    async pi(...args) { calls.push(args); return { ok: true, value: [] }; },
    async messaging(...args) { calls.push(args); return { ok: true, value: [] }; },
    async slack(...args) { calls.push(args); return { ok: false, error: { code: "unsupported", message: "Removal unavailable" } }; },
  };
  expect(await reactToMessage({ messageId: messageReference(target), emoji: "❤️" }, owner, transports)).toEqual({ ok: true, value: [] });
  expect(calls[0]).toEqual([target, "❤️", false, owner]);
  await reactToMessage({ messageId: "messaging/received", emoji: "🇬🇧", remove: true }, owner, transports);
  expect(calls[1]).toEqual(["received", "🇬🇧", true]);
  expect(await reactToMessage({ messageId: "slack/T123/C123/1234.000005", emoji: ":heart:", remove: true, threadTs: "1234.000001" }, owner, transports)).toMatchObject({ ok: false, error: { code: "unsupported" } });
  expect(calls[2]).toEqual([{ transport: "slack", workspace: "T123", channel: "C123", messageId: "1234.000005", threadTs: "1234.000001" }, ":heart:", true]);
  for (const request of [{ messageId: "missing", emoji: "❤️" }, { messageId: "messaging/m", emoji: "heart" }, { messageId: "pi/a/b", emoji: "❤️", remove: "true" }]) {
    expect((await reactToMessage(request, owner, transports)).ok).toBe(false);
  }
  expect(calls).toHaveLength(3);
});

test("Pi reactions survive restart, are idempotent, and cannot remove someone else's reaction", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-reactions-"));
  const file = join(root, "supervisor.sqlite3");
  let db = new Database(file);
  try {
    let ledger = new PiReactions(db, owner);
    const first = ledger.set(target, "❤️", owner, false);
    expect(ledger.set(target, "❤️", owner, false)).toEqual(first);
    ledger.set(target, "❤️", { id: "assistant", name: "Kenan" }, false);
    expect(ledger.set(target, "❤️", owner, true)).toMatchObject([{ sender: { id: "assistant" }, own: false }]);
    db.close();
    db = new Database(file);
    ledger = new PiReactions(db, owner);
    expect(ledger.list(messageReference(target))).toMatchObject([{ emoji: "❤️", sender: { id: "assistant" } }]);
    expect(ledger.session("another-thread").size).toBe(0);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("reaction projection changes heads without changing immutable message bodies", () => {
  const db = new Database(":memory:");
  try {
    const ledger = new PiReactions(db, owner);
    const identity = { id: messageReference(target), timestamp: 1_700_000_000_000, sender: owner };
    const document = JSON.stringify({ messages: [{ role: "user", content: "Hello", timestamp: identity.timestamp, identity }] });
    const before = deriveTranscriptItems(JSON.parse(ledger.project(target.sessionId, document))).at(-1)!;
    ledger.set(target, "❤️", { id: "assistant", name: "Kenan" }, false);
    const after = deriveTranscriptItems(JSON.parse(ledger.project(target.sessionId, document))).at(-1)!;
    expect(after.body).toBe(before.body);
    expect(after.head.id).toBe(before.head.id);
    expect(after.head).toMatchObject({ identity, reactions: [{ emoji: "❤️", sender: { id: "assistant" } }] });
    expect(before.head).toMatchObject({ reactions: [] });
    expect(JSON.parse(document).messages[0].reactions).toBeUndefined();
  } finally { db.close(); }
});

test("only actual conversational native entries can be local reaction targets", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-reaction-native-"));
  const path = join(root, "thread.jsonl");
  try {
    writeFileSync(path, [
      { type: "session", id: "session" },
      { type: "message", id: "user", message: { role: "user" } },
      { type: "message", id: "tool", message: { role: "toolResult" } },
      { type: "custom_message", id: "external", details: { sender: { id: "slack-user" } } },
    ].map(value => JSON.stringify(value)).join("\n") + "\n");
    expect(await nativeMessageExists(path, "user")).toBe(true);
    expect(await nativeMessageExists(path, "external")).toBe(true);
    for (const id of ["session", "tool", "missing"]) expect(await nativeMessageExists(path, id)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
