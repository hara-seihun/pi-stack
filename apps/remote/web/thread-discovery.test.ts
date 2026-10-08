import { expect, test } from "bun:test";
import { ThreadDiscovery, type DiscoveryResult } from "./src/thread-discovery";

const drain = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test("known fleet rows never fetch; in-flight references coalesce", async () => {
  const calls: string[] = [], accepted: string[] = [];
  const known = new Set(["local", "fleet", "discovered"]);
  const discovery = new ThreadDiscovery<string>({
    known: id => known.has(id), now: () => 0, changed: () => {},
    load: async id => { calls.push(id); return { ok: true, value: id }; },
    accept: id => { accepted.push(id); known.add(id); },
  });
  discovery.discover(["local", "fleet", "discovered", "new", "new"]);
  discovery.discover(["new"]);
  await drain();
  expect(calls).toEqual(["new"]);
  expect(accepted).toEqual(["new"]);
});

test("missing and transient lookups stay local, throttle repeats, and can recover", async () => {
  let now = 0, attempts = 0, changes = 0;
  const accepted: string[] = [];
  const discovery = new ThreadDiscovery<string>({
    known: () => false, now: () => now, changed: () => { changes++; },
    load: async id => ++attempts === 1
      ? { ok: false, error: { code: "not_found", message: "Thread not found" } }
      : { ok: true, value: id },
    accept: id => { accepted.push(id); },
  });
  discovery.discover(["old"]);
  await drain();
  expect(discovery.error("old")).toBe("Thread not found");
  for (let i = 0; i < 100; i++) discovery.discover(["old"]);
  expect(attempts).toBe(1);
  now = 30_000;
  discovery.discover(["old"]);
  await drain();
  expect(attempts).toBe(2);
  expect(discovery.error("old")).toBeNull();
  expect(accepted).toEqual(["old"]);
  expect(changes).toBe(2);
});

test("long historical transcripts bound lookup fanout and recheck queued fleet arrivals", async () => {
  const pending = new Map<string, (result: DiscoveryResult<string>) => void>();
  const known = new Set<string>();
  const discovery = new ThreadDiscovery<string>({
    known: id => known.has(id), now: () => 0, changed: () => {}, accept: () => {},
    load: id => new Promise(resolve => pending.set(id, resolve)),
  });
  discovery.discover(["a", "b", "c", "d", "e", "f"]);
  expect([...pending.keys()]).toEqual(["a", "b", "c", "d"]);
  known.add("e");
  pending.get("a")!({ ok: true, value: "a" });
  await drain();
  expect(pending.has("e")).toBe(false);
  expect(pending.has("f")).toBe(true);
  for (const [id, resolve] of pending) resolve({ ok: true, value: id });
  await drain();
});

test("disposing an auth lifetime discards queued and late results", async () => {
  const pending = new Map<string, (result: DiscoveryResult<string>) => void>();
  const accepted: string[] = [];
  let changes = 0;
  const discovery = new ThreadDiscovery<string>({
    known: () => false, now: () => 0, changed: () => { changes++; },
    accept: id => { accepted.push(id); },
    load: id => new Promise(resolve => pending.set(id, resolve)),
  });
  discovery.discover(["a", "b", "c", "d", "queued"]);
  discovery.dispose();
  discovery.discover(["after-unmount"]);
  for (const [id, resolve] of pending) resolve({ ok: true, value: id });
  await drain();
  expect([...pending.keys()]).toEqual(["a", "b", "c", "d"]);
  expect(accepted).toEqual([]);
  expect(changes).toBe(0);
  expect(discovery.error("a")).toBeNull();
});

test("foreign failures and invalid response acceptance become local typed failures", async () => {
  const discovery = new ThreadDiscovery<string>({
    known: () => false, now: () => 0, changed: () => {},
    load: async id => { if (id === "network") throw new Error("Offline"); return { ok: true, value: id }; },
    accept: () => { throw new Error("Invalid session"); },
  });
  discovery.discover(["network", "invalid"]);
  await drain();
  expect(discovery.error("network")).toBe("Offline");
  expect(discovery.error("invalid")).toBe("Invalid session");
});
