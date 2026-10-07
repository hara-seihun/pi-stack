import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { TranscriptItemBody, TranscriptItemHead } from "../server/protocol";
import type { BodyCache } from "./src/client-cache";
import { ItemBodies, ItemBodiesContext } from "./src/features/conversation/item-bodies";
import { completeMessageEntry, loadMessageEntry } from "./src/features/conversation/message-body";
import { entryFromHead } from "./src/features/conversation/transcript-entries";
import { Transcript } from "./src/features/conversation/Transcript";

globalThis.location ??= new URL("https://router.test/") as unknown as Location;
const words = "EXACT_NATIVE_MESSAGE_λ ".repeat(20_000);
const head = (kind: "user" | "assistant" | "notice"): TranscriptItemHead => ({
  kind, id: `body-${kind}`, seq: 1, size: Buffer.byteLength(words), timestamp: 7,
  text: words.slice(0, 120) + "…", textTruncated: true,
});

test("wire preview markers reach entries and invalidate otherwise identical full-head signatures", () => {
  for (const kind of ["user", "assistant", "notice"] as const) {
    const preview = entryFromHead(head(kind));
    expect(preview.textTruncated).toBe(true);
    const full = entryFromHead({ ...head(kind), text: words, textTruncated: undefined });
    expect(full.textTruncated).toBeUndefined();
    expect(preview.signature).not.toBe(full.signature);
  }
  expect(() => entryFromHead({ ...head("user"), textTruncated: false } as unknown as TranscriptItemHead)).toThrow("invalid marker");
});

test("loading exact message words preserves edit/resend identity and metadata and clears preview state", async () => {
  for (const kind of ["user", "assistant", "notice"] as const) {
    const entry = { ...entryFromHead(head(kind)), identity: { id: "source-id", timestamp: 7, sender: { id: "person", name: "User" } } };
    let loads = 0;
    const full = await loadMessageEntry(entry, async () => { loads++; return { kind, text: words }; });
    expect(full.ok).toBe(true);
    if (!full.ok) throw new Error(full.error.message);
    expect(full.value.text).toBe(words);
    expect(full.value.textTruncated).toBeUndefined();
    expect(full.value.identity).toEqual(entry.identity);
    expect(full.value.messageTimestamp).toBe(7);
    expect(full.value.itemId).toBe(entry.itemId);
    expect(full.value.signature).not.toBe(entry.signature);
    expect(loads).toBe(1);
    expect(entry.textTruncated).toBe(true);
  }
});

test("missing or mismatched bodies cannot silently copy or edit a preview", async () => {
  const entry = entryFromHead(head("user"));
  expect(await loadMessageEntry(entry, async () => undefined)).toMatchObject({ ok: false, error: { code: "body-unavailable" } });
  expect(await loadMessageEntry(entry, async () => { throw new Error("Native source changed"); })).toMatchObject({ ok: false, error: { code: "body-unavailable", message: "Native source changed" } });
  expect(completeMessageEntry(entry, { kind: "assistant", text: words })).toMatchObject({ ok: false, error: { code: "invalid-body" } });
  expect(completeMessageEntry(entry, { kind: "toolCall", arguments: {}, result: null })).toMatchObject({ ok: false, error: { code: "invalid-body" } });
  const full = entryFromHead({ ...head("user"), text: "Complete short message", textTruncated: undefined });
  expect(await loadMessageEntry(full, async () => { throw new Error("No fetch for full inline text"); })).toEqual({ ok: true, value: full });
});

test("ordinary large messages offer explicit load and exact copy without rendering their cached full body eagerly", () => {
  const cached = new Map<string, TranscriptItemBody>();
  for (const kind of ["user", "assistant"] as const) cached.set(head(kind).id, { kind, text: words });
  let requests = 0;
  const cache: BodyCache = {
    getBody: id => cached.get(id), retainBody: () => () => {}, acceptBody: (id, body) => { cached.set(id, body); },
    loadBody: (_id, _size, fetcher) => fetcher(),
  };
  const bodies = new ItemBodies("thread", async () => { requests++; throw new Error("Unexpanded messages do not request full bodies"); }, cache);
  const html = renderToStaticMarkup(<ItemBodiesContext.Provider value={bodies}><Transcript
    entries={[entryFromHead(head("user")), entryFromHead({ ...head("assistant"), seq: 2 })]}
    sessionId="thread" home="/" images={null} onEdit={() => {}} onReply={() => {}}
  /></ItemBodiesContext.Provider>);
  expect(html.match(/Load full message/g)).toHaveLength(2);
  expect(html.match(/aria-label="Copy full message"/g)).toHaveLength(2);
  expect(html).not.toContain(words);
  expect(requests).toBe(0);
});
