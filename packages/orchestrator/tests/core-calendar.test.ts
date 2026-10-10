import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCoreCalendar, parseCoreCalendarConfig, type CoreCalendarConfig } from "../src/core/calendar.js";
import type { Grant, PermissionPolicy } from "../src/permissions.js";
import type { CoreScope } from "../src/core/contracts.js";
const configured: CoreCalendarConfig = { id: "alice-calendar", person: "alice", custodyScopeId: "alice", databasePath: "/fixture/calendar.sqlite3", adoptionReceiptPath: "/fixture/calendar-adoption.json", memoryFolder: "/fixture/memory", journalDirectory: "/fixture/actions", resource: { id: "alice-calendar", kind: "data", owner: "alice", subjects: ["alice"], privacy: "private", consent: "not-required" } };
test("calendar memory requires explicit paths and private owned dataset identity", () => {
  expect(parseCoreCalendarConfig(configured).ok).toBe(true);
  for (const patch of [{ journalDirectory: undefined }, { memoryFolder: "/fixture/../other" }, { resource: { ...configured.resource, privacy: "public" } }, { person: "bob" }, { resource: { ...configured.resource, subjects: ["alice", "bob"] } }]) expect(parseCoreCalendarConfig({ ...configured, ...patch }).ok).toBe(false);
});
test("adopted calendar data checks every command grant, never implies ownership/service authority, and releases custody", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memory-calendar-")), databasePath = join(dir, "calendar.sqlite3"), adoptionReceiptPath = join(dir, "receipt.json"), memoryFolder = join(dir, "memory"), journalDirectory = join(dir, "actions");
  mkdirSync(memoryFolder); mkdirSync(journalDirectory);
  for (const file of ["README.md", "AGENTS.md"]) writeFileSync(join(memoryFolder, file), "# Granted memory\n");
  const db = new Database(databasePath); db.exec("CREATE TABLE events(id TEXT PRIMARY KEY,body TEXT NOT NULL);CREATE TABLE subscriptions(id TEXT PRIMARY KEY,body TEXT NOT NULL,ics TEXT);CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE delete_undo(token TEXT PRIMARY KEY,before TEXT,after TEXT,expires INTEGER)"); db.close();
  const identity = statSync(databasePath, { bigint: true });
  writeFileSync(adoptionReceiptPath, JSON.stringify({ version: 1, state: "detached", scopeId: configured.id, databasePath, databaseIdentity: { dev: String(identity.dev), ino: String(identity.ino) }, previousOwner: { identity: "fixture-original-calendar", detachedAt: "2026-10-10T00:00:00Z" } }), { mode: 0o600 });
  const config = { ...configured, databasePath, adoptionReceiptPath, memoryFolder, journalDirectory };
  const processStat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
  const namespace = { kind: "process" as const, pid: process.pid, startTicks: processStat.slice(processStat.lastIndexOf(")") + 2).split(/\s+/)[19]!, mountNamespaceInode: statSync(`/proc/${process.pid}/ns/mnt`, { bigint: true }).ino.toString() };
  const scope: CoreScope = { id: "alice", principalId: "alice", availability: { kind: "adopt" }, resource: { id: "alice", kind: "data", owner: "alice", subjects: ["alice"], privacy: "private", consent: "not-required" }, storage: { databasePath, adoptionReceiptPath, sessionsDir: dir, capabilityKeyPath: join(dir, "key") }, custody: { uid: process.getuid!(), gid: process.getgid!(), namespace, retainedRunnerNamespace: namespace, dataDir: dir, socketDir: dir }, resources: [], environment: {}, manager: { kind: "none" }, managerRouting: { kind: "none" } };
  const grants: Grant[] = [{ id: "calendar-read", principal: "alice", resource: { kind: "exact", id: configured.id }, actions: ["read"], effect: "allow", validFrom: 0, validUntil: null, issuedBy: "fixture", source: "fixture" }];
  const policy: PermissionPolicy = { revision: 1, consents: [], grants };
  const options = { config, policy, scopes: [scope], owner: () => ({ ok: true as const, value: { runtime: { path: (path: string) => { if (![databasePath, adoptionReceiptPath, memoryFolder, journalDirectory].includes(path)) throw new Error("unregistered path"); return path; } } } }) };
  const built = createCoreCalendar(options); expect(built.ok).toBe(true); if (!built.ok) { rmSync(dir, { recursive: true, force: true }); return; }
  try {
    const alice = { kind: "person" as const, id: "alice", person: "alice" };
    expect((await built.value.execute(alice, "read", { operation: "records" })).ok).toBe(true);
    expect(await built.value.execute({ kind: "service", id: "root" }, "root-read", { operation: "records" })).toMatchObject({ ok: false, error: "unauthenticated" });
    const command = { operation: "create", event: { title: "Fixture event", start: "2026-10-10T10:00:00Z", end: "2026-10-10T11:00:00Z", zone: "UTC", allDay: false, repeat: null, repeatUntil: null, notes: "", location: "" } };
    expect(await built.value.execute(alice, "create", command)).toMatchObject({ ok: false, error: "unauthenticated" });
    grants.push({ ...policy.grants[0]!, id: "calendar-write", actions: ["write"] });
    expect((await built.value.execute(alice, "create", command)).ok).toBe(true);
    expect(createCoreCalendar(options)).toMatchObject({ ok: false, error: { code: "ownership-conflict" } });
  } finally { await built.value.close(); }
  const reattached = createCoreCalendar(options); expect(reattached.ok).toBe(true); if (reattached.ok) await reattached.value.close();
  rmSync(dir, { recursive: true, force: true });
});
