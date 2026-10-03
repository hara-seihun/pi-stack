import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ActionJournal, actionObviouslyPrivate, actionJournalDirectory, journalDrainDirectories, journalClient } from "../src/journal.ts";
import type { MemoryClient, MemoryInput } from "../src/contract.ts";
import { MemoryStore } from "../src/store.ts";
import { memoryService } from "../src/service.ts";
const roots: string[] = [];
function root() { const path = mkdtempSync(join(tmpdir(), "kenan-journal-")); roots.push(path); return path; }
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
function client(accepted: MemoryInput[], available = () => true): MemoryClient {
  return { async request(input) {
    if (!available()) return { ok: false, error: "unavailable", message: "fixture outage" };
    if (input.operation !== "write") throw new Error("unexpected operation");
    accepted.push(input.item);
    return { ok: true, value: input.item as any };
  } } as MemoryClient;
}
test("disabled journal has no files, memory request, or changed action", async () => {
  const directory = join(root(), "not-created"), accepted: MemoryInput[] = [];
  const journal = new ActionJournal({ directory, enabled: () => false, client: client(accepted), autoDrain: false });
  expect(journal.begin({ action: "email.send", recipients: ["gaetane@example.test"], summary: "Foundation" })).toBeNull();
  expect(journal.finish(null, "confirmed")).toEqual({ ok: true });
  expect(await journal.drain()).toEqual({ ok: true });
  expect(accepted).toHaveLength(0);
  expect(readdirSync(join(directory, ".."))).toHaveLength(0);
});
test("outage survives a new process and drains confirmed and attempted truth separately", async () => {
  const directory = root(), accepted: MemoryInput[] = [];
  let available = false;
  const options = { directory, enabled: () => true, person: "alice", client: client(accepted, () => available), autoDrain: false };
  const journal = new ActionJournal(options);
  const ticket = journal.begin({ action: "email.send", recipients: ["Gaétane"], summary: "Foundation schedule", affected: ["sybil"], externalId: "smtp-id" });
  expect(readdirSync(directory)).toHaveLength(1);
  expect(journal.finish(ticket, "confirmed", "SMTP accepted smtp-id")).toEqual({ ok: true });
  expect(await journal.drain()).toMatchObject({ ok: false });
  expect(readdirSync(directory)).toHaveLength(2);
  available = true;
  expect(await new ActionJournal(options).drain()).toEqual({ ok: true });
  expect(accepted).toHaveLength(2);
  expect(accepted.find(item => item.source.action === "email.send:confirmed")).toMatchObject({ about: ["alice", "sybil", "Gaétane"], source: { actedFor: "alice" }, setting: { person: "alice" } });
  expect(accepted.some(item => item.text.includes("completed email.send") && item.text.includes("Gaétane"))).toBe(true);
  expect(readdirSync(directory)).toHaveLength(0);
});
test("dispatch without outcome is never called a completed action", async () => {
  const accepted: MemoryInput[] = [], journal = new ActionJournal({ directory: root(), enabled: () => true, client: client(accepted), autoDrain: false });
  journal.begin({ action: "phone.sms.send", recipients: ["+15555550100"], summary: "hello" });
  await journal.drain();
  expect(accepted[0]!.source.action).toBe("phone.sms.send:attempted");
  expect(accepted[0]!.text).toContain("not proof it happened");
});
test("intent disk failure occurs before dispatch, outcome failure warns rather than claiming failure", () => {
  const directory = join(root(), "file"), journal = new ActionJournal({ directory, enabled: () => true, autoDrain: false });
  writeFileSync(directory, "cannot be a directory");
  expect(() => journal.begin({ action: "email.send", recipients: [], summary: "hello" })).toThrow();
  const warning = journal.finish({ id: crypto.randomUUID(), spec: { action: "email.send", recipients: [], summary: "hello" }, startedAt: new Date().toISOString() }, "confirmed");
  expect(warning).toMatchObject({ ok: false });
  if (!warning.ok) expect(warning.error).toContain("Do not repeat");
});
test("obvious intimate actions remain in confidence without asking the sender to log", () => {
  expect(actionObviouslyPrivate({ action: "email.send", recipients: ["Doctor"], summary: "Prescription and medication changes" })).toBe(true);
  expect(actionObviouslyPrivate({ action: "email.send", recipients: ["Gaétane"], summary: "Foundation schedule" })).toBe(false);
});
test("replayed confirmed receipt keeps its external id for store idempotency", async () => {
  const directory = root(), accepted: MemoryInput[] = [], journal = new ActionJournal({ directory, enabled: () => true, client: client(accepted), autoDrain: false });
  const ticket = journal.begin({ action: "calendar.create", recipients: ["alice"], summary: "House" });
  journal.finish(ticket, "confirmed");
  const file = readdirSync(directory).find(name => name.includes("confirmed"))!;
  const body = readFileSync(join(directory, file));
  await journal.drain();
  writeFileSync(join(directory, file), body);
  await journal.drain();
  const confirmations = accepted.filter(item => item.source.action === "calendar.create:confirmed");
  expect(confirmations).toHaveLength(2);
  expect(confirmations[0]!.source.externalId).toBe(confirmations[1]!.source.externalId);
});

test("machine-wide CLI admits nonzero service UID through filesystem and service capabilities", () => {
  const directory = root(), registry = root(), host = join(root(), "host.json");
  writeFileSync(host, JSON.stringify({ oneKenan: true }));
  const result = spawnSync(process.execPath, [new URL("../src/journal-cli.ts", import.meta.url).pathname, "drain", "--all"], {
    env: { PATH: process.env.PATH, PI_STACK_HOST_CONFIG: host, PI_REMOTE_PERSONS_DIR: registry, PI_KENAN_ACTION_JOURNAL_DIR: directory },
    encoding: "utf8", timeout: 5000,
  });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ ok: true });
  expect(readdirSync(directory)).toHaveLength(0);
});
test("ordinary UID uses its existing private mount even with root-only environment spool", () => {
  const privateDir = root(), config = join(root(), "person.json");
  writeFileSync(config, JSON.stringify({ unlock: { mountpoint: privateDir } }));
  const env = { PI_REMOTE_CONFIG: config, PI_KENAN_ACTION_JOURNAL_DIR: "/root/private/action-journal" };
  expect(actionJournalDirectory(env, 1001)).toBe(join(privateDir, ".kenan-actions"));
  expect(actionJournalDirectory(env, 0)).toBe("/root/private/action-journal");
});
test("root drain discovers only known mounted person journals plus its root spool", async () => {
  const registry = root(), alice = root(), bob = root(), unavailable = root(), shared = root(), items: MemoryInput[] = [];
  for (const [user, mountpoint] of [["alice", alice], ["bob", bob], ["locked", unavailable]]) {
    writeFileSync(join(registry, `${user}.json`), JSON.stringify({ version: 1, unlock: { mountpoint } }));
  }
  const env = { PI_REMOTE_PERSONS_DIR: registry, PI_KENAN_ACTION_JOURNAL_DIR: shared };
  const paths = journalDrainDirectories(env, path => path !== unavailable);
  expect(paths).toEqual([shared, join(alice, ".kenan-actions"), join(bob, ".kenan-actions")]);
  for (const [person, directory] of [["root", shared], ["alice", paths[1]!], ["bob", paths[2]!]]) {
    const journal = new ActionJournal({ directory, person, enabled: () => true, autoDrain: false, client: client(items) });
    const ticket = journal.begin({ action: "email.send", recipients: ["Gaétane"], summary: "Foundation schedule" });
    journal.finish(ticket, "confirmed");
  }
  for (const directory of paths) expect(await new ActionJournal({ directory, enabled: () => true, autoDrain: false, client: client(items) }).drain()).toEqual({ ok: true });
  expect(items.filter(item => item.source.action === "email.send:confirmed").map(item => item.setting.person).sort()).toEqual(["alice", "bob", "root"]);
});
test("missing publisher uses verified UID, never expired inherited session token", async () => {
  const previous = { ...process.env }, store = new MemoryStore(join(root(), "memory.sqlite3"));
  const service = memoryService({ store, auth: { supervisors: [], uidPersons: { "1001": "alice" } }, enabled: () => true, peerUid: () => 1001 });
  await new Promise<void>(resolve => service.listen(0, "127.0.0.1", resolve));
  const address = service.address() as { port: number };
  try {
    process.env.PI_KENAN_MEMORY_URL = `http://127.0.0.1:${address.port}`;
    process.env.PI_KENAN_MEMORY_TOKEN = "expired-session-from-another-thread";
    process.env.PI_KENAN_MEMORY_PUBLISHER_TOKEN_FILE = join(root(), "missing");
    const result = await journalClient().request({ operation: "write", item: { text: "Kenan sent fixture mail for alice", about: ["alice", "Gaétane"], source: { actedFor: "alice", action: "email.send:confirmed", externalId: "fixture-replay" }, setting: { person: "alice", threadId: "original-thread" }, obviouslyPrivate: false } });
    expect(result.ok).toBe(true);
  } finally {
    await new Promise<void>((resolve, reject) => service.close(error => error ? reject(error) : resolve()));
    store.close();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});
