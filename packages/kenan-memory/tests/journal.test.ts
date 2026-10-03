import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionJournal, actionObviouslyPrivate } from "../src/journal.ts";
import type { MemoryClient, MemoryInput } from "../src/contract.ts";
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
