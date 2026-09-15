import { afterEach, beforeEach, expect, test } from "bun:test";
import { ThreadNotifications, threadNotificationKey } from "./src/thread-notifications";

const originals = { Notification: globalThis.Notification, BroadcastChannel: globalThis.BroadcastChannel, locks: navigator.locks };
const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
beforeEach(() => Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("https://router.test/") }));
afterEach(() => {
  if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation);
  else delete (globalThis as any).location;
});
const held = new Map<string, number>();
const shown: FakeNotification[] = [];
const channels = new Set<FakeChannel>();
class FakeNotification {
  closed = false;
  onclick?: () => void;
  onclose?: () => void;
  constructor(readonly title: string, readonly options: NotificationOptions) { shown.push(this); }
  close() { this.closed = true; this.onclose?.(); }
}
class FakeChannel {
  onmessage?: (event: { data: string }) => void;
  constructor() { channels.add(this); }
  postMessage(data: string) { for (const peer of channels) if (peer !== this) peer.onmessage?.({ data }); }
  close() { channels.delete(this); }
}
function setup() {
  Object.assign(globalThis, { Notification: FakeNotification, BroadcastChannel: FakeChannel });
  Object.defineProperty(navigator, "locks", { configurable: true, value: {
    async request(key: string, options: LockOptions, callback: (lock: object | null) => unknown) {
      if (options.signal?.aborted) throw options.signal.reason;
      if (options.ifAvailable && held.has(key)) return callback(null);
      held.set(key, (held.get(key) ?? 0) + 1);
      try { return await callback({ name: key }); }
      finally {
        const count = held.get(key)! - 1;
        if (count) held.set(key, count); else held.delete(key);
      }
    },
  } });
}
afterEach(() => {
  Object.assign(globalThis, { Notification: originals.Notification, BroadcastChannel: originals.BroadcastChannel });
  Object.defineProperty(navigator, "locks", { configurable: true, value: originals.locks });
  held.clear(); shown.length = 0; channels.clear();
});

test("opening a thread dismisses across tabs and suppresses only that person and environment", async () => {
  setup();
  const first = new ThreadNotifications();
  const second = new ThreadNotifications();
  const key = threadNotificationKey("kenan", "local", "123");
  await first.show(key, "Finished", () => {});
  const visible = new AbortController();
  const viewing = second.view(key, visible.signal);
  expect(shown[0].closed).toBe(true);
  await first.show(key, "Still visible", () => {});
  expect(shown).toHaveLength(1);
  await first.show(threadNotificationKey("kenan", "converge", "123"), "Other environment", () => {});
  await first.show(threadNotificationKey("sibyl", "local", "123"), "Other person", () => {});
  await first.show(threadNotificationKey("kenan", "local", "456"), "Other thread", () => {});
  expect(shown).toHaveLength(4);
  visible.abort();
  await viewing;
  await first.show(key, "Backgrounded", () => {});
  expect(shown).toHaveLength(5);
  expect(shown[4].options.icon).toBe("/kenan.png");
  first.dispose(); second.dispose();
});

test("repeated completions replace one thread notification and disposed owners cannot post", async () => {
  setup();
  const notifications = new ThreadNotifications();
  const key = threadNotificationKey("kenan", "local", "123");
  let opened = false;
  await notifications.show(key, "First", () => {});
  await notifications.show(key, "Second", () => { opened = true; });
  expect(shown[0].closed).toBe(true);
  shown[1].onclick?.();
  expect(opened).toBe(true);
  expect(shown[1].closed).toBe(true);
  notifications.dispose();
  await notifications.show(key, "Too late", () => {});
  expect(shown).toHaveLength(2);
});
