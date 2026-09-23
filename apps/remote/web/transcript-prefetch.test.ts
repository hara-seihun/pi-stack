import { expect, test } from "bun:test";
import type { Session, TranscriptItemHead } from "../server/protocol";
import { createLiveText } from "./src/features/conversation/live-text";
import { forgetPrefetchedTranscripts, prefetchTranscript, prefetchUnreadThreads, prefetchWelcome, takePrefetchedWindow } from "./src/features/conversation/transcript-prefetch";

const user = (seq: number): TranscriptItemHead => ({ seq, id: `u${seq}`, kind: "user", size: 4, text: `hello ${seq}` });

function page(sessionId: string, items = [user(0), user(1)]) {
  return new Response(JSON.stringify({ sessionId, generation: "g1", total: items.length, items }), { status: 200 });
}

function recorder(answer: (path: string) => Response = path => page(path)) {
  const paths: string[] = [];
  return { paths, fetcher: async (path: string) => { paths.push(path); return answer(path); } };
}

const session = (id: string, patch: Partial<Session> = {}): Session => ({
  id, parentId: null, hasChildren: false, origin: "person", model: "model", name: id,
  cwd: "/", workspaceName: "", environment: "local", state: "idle", held: false, activity: "idle", activeTools: [],
  provider: "openai", createdAt: "", updatedAt: "2026-01-01T00:00:00Z", revision: 1, idleUnread: false,
  queuedMessages: [], archivedAt: null, ...patch,
});

test("a pressed row's newest window is fetched once and used once", async () => {
  forgetPrefetchedTranscripts();
  const { paths, fetcher } = recorder();
  prefetchTranscript("thread-a", { fetcher });
  // Pressing again within the freshness window does not ask again.
  prefetchTranscript("thread-a", { fetcher });
  expect(paths).toHaveLength(1);
  expect(paths[0]).toContain("/v1/sessions/thread-a/transcript");
  expect(paths[0]).not.toContain("before=");

  const window = await takePrefetchedWindow("thread-a");
  expect(window?.items.map(item => item.seq)).toEqual([0, 1]);
  // Used once: the stream owns the window from here.
  expect(await takePrefetchedWindow("thread-a")).toBeNull();
  expect(await takePrefetchedWindow("never-pressed")).toBeNull();
});

test("a failed or empty prefetch costs the conversation nothing", async () => {
  forgetPrefetchedTranscripts();
  prefetchTranscript("gone", { fetcher: async () => new Response(JSON.stringify({ error: "No such session" }), { status: 404 }) });
  expect(await takePrefetchedWindow("gone")).toBeNull();

  forgetPrefetchedTranscripts();
  prefetchTranscript("fresh-thread", { fetcher: async path => page(path, []) });
  expect(await takePrefetchedWindow("fresh-thread")).toBeNull();
});

test("arrival prefetches the newest unread threads, and nothing on a metered connection", async () => {
  forgetPrefetchedTranscripts();
  const { paths, fetcher } = recorder();
  const sessions = [
    session("read", { updatedAt: "2026-02-01T00:00:00Z" }),
    session("old-unread", { idleUnread: true, updatedAt: "2026-01-01T00:00:00Z" }),
    session("new-unread", { idleUnread: true, updatedAt: "2026-03-01T00:00:00Z" }),
    session("middle-unread", { idleUnread: true, updatedAt: "2026-02-01T00:00:00Z" }),
    session("fourth-unread", { idleUnread: true, updatedAt: "2026-02-15T00:00:00Z" }),
    session("archived-unread", { idleUnread: true, updatedAt: "2026-04-01T00:00:00Z", archivedAt: "2026-04-02T00:00:00Z" }),
  ];
  expect(prefetchUnreadThreads(sessions, { fetcher, welcome: true }))
    .toEqual(["new-unread", "fourth-unread", "middle-unread"]);
  expect(paths).toHaveLength(3);

  forgetPrefetchedTranscripts();
  const metered = recorder();
  expect(prefetchUnreadThreads(sessions, { fetcher: metered.fetcher, welcome: false })).toEqual([]);
  expect(metered.paths).toHaveLength(0);
});

test("speculative loading stays off Data Saver and off a slow connection", () => {
  expect(prefetchWelcome(undefined)).toBe(true);
  expect(prefetchWelcome({ saveData: true, effectiveType: "4g" })).toBe(false);
  expect(prefetchWelcome({ effectiveType: "4g" })).toBe(true);
  expect(prefetchWelcome({ effectiveType: "3g" })).toBe(false);
  expect(prefetchWelcome({ effectiveType: "slow-2g" })).toBe(false);
  expect(prefetchWelcome({})).toBe(true);
});

test("live text appends, resets and resyncs without touching the rest of the app", () => {
  let resyncs = 0;
  const live = createLiveText(() => { resyncs++; });
  let notified = 0;
  const stop = live.subscribe(() => { notified++; });

  live.apply({ text: { reset: "Hel" } });
  live.apply({ text: { append: "lo", length: 5 } });
  expect(live.snapshot()).toEqual({ text: "Hello", thinking: "" });
  expect(resyncs).toBe(0);

  // An append that lands on text this client never had asks for a fresh stream.
  live.apply({ text: { append: "!", length: 99 } });
  expect(resyncs).toBe(1);

  live.apply({ thinking: { append: "Weighing", length: 8 } });
  expect(live.snapshot().thinking).toBe("Weighing");
  live.clearThinking();
  expect(live.snapshot()).toEqual({ text: "Hello!", thinking: "" });

  const held = live.snapshot();
  live.apply({});
  expect(live.snapshot()).toBe(held);
  live.reset();
  expect(live.snapshot()).toEqual({ text: "", thinking: "" });

  const quiet = notified;
  live.reset();
  expect(notified).toBe(quiet);
  stop();
  live.apply({ text: { reset: "after" } });
  expect(notified).toBe(quiet);
});
