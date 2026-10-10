import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreDuties, parseCoreDutiesConfig, WATCH_CUSTODY_TABLES } from "../src/core/duties-runtime.js";
import { ThreadService } from "../src/threads/service.js";
import type { CoreScope } from "../src/core/contracts.js";
import type { PermissionPolicy, Principal } from "../src/permissions.js";

const roots: string[] = [], plugins: CoreDuties[] = [], services: ThreadService[] = [];
afterEach(async () => {
  for (const plugin of plugins.splice(0)) await plugin.close();
  for (const service of services.splice(0)) await service.detach();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(input: { spool?: "hold" | "drain"; granted?: boolean; inactive?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "duties-runtime-")); roots.push(root);
  const watchPath = join(root, "supervisor.sqlite"), receiptPath = join(root, "watch-receipt.json"), path = join(root, "duties.md");
  const db = new DatabaseSync(watchPath);
  db.exec(`CREATE TABLE watch_item(id TEXT PRIMARY KEY,body TEXT NOT NULL);
    CREATE TABLE watch_request(id TEXT PRIMARY KEY,input TEXT NOT NULL,response TEXT NOT NULL);
    CREATE TABLE watch_wake(id TEXT PRIMARY KEY,input TEXT NOT NULL);
    CREATE TABLE watch_delivery(id TEXT PRIMARY KEY,retryAt INTEGER NOT NULL,error TEXT NOT NULL);
    CREATE TABLE watch_schedule(id INTEGER PRIMARY KEY,nextWakeAt INTEGER NOT NULL);
    INSERT INTO watch_schedule VALUES(1,123);
    CREATE TABLE unrelated_images(id TEXT PRIMARY KEY,body TEXT);`);
  const identity = statSync(watchPath, { bigint: true });
  writeFileSync(receiptPath, JSON.stringify({ version: 1, state: "detached", scopeId: "person:watch", databasePath: watchPath,
    databaseIdentity: { dev: String(identity.dev), ino: String(identity.ino) }, tableNames: WATCH_CUSTODY_TABLES,
    previousOwner: { identity: "original-supervisor", detachedAt: "2026-10-10T20:00:00Z" } }), { mode: 0o600 });
  const service = new ThreadService({ databasePath: join(root, "threads.sqlite"), sessionsDir: root, capacity: { mode: "unmanaged" }, openSession: vi.fn() });
  services.push(service);
  const resource = { id: "person-threads", kind: "thread", owner: "person", privacy: "private", subjects: ["person"], consent: "not-required" } as const;
  const scope: CoreScope = { id: "person", principalId: "person", availability: input.inactive ? { kind: "unavailable", reason: "inactive" } : { kind: "adopt" }, resource,
    storage: { databasePath: join(root, "threads.sqlite"), sessionsDir: root, capabilityKeyPath: join(root, "capability"), adoptionReceiptPath: join(root, "thread-receipt") },
    custody: { uid: process.getuid!(), gid: process.getgid!(), namespace: { kind: "host" }, retainedRunnerNamespace: { kind: "host" }, dataDir: root, socketDir: root },
    resources: [{ path: root, kind: "directory" }], environment: {}, manager: { kind: "none" }, managerRouting: { kind: "none" } };
  const principal: Principal = { kind: "person", id: "person", person: "person" };
  const policy: PermissionPolicy = { revision: 1, grants: input.granted === false ? [] : [{ id: "dispatch", principal: "person", resource: { kind: "exact", id: resource.id },
    actions: ["dispatch"], effect: "allow", validFrom: 0, validUntil: null, issuedBy: "person", source: "test grant" }], consents: [] };
  const owner = vi.fn(() => ({ ok: true as const, value: { threads: service, runtime: { path: (logical: string) => {
    if (logical !== root && !logical.startsWith(root + "/")) throw new Error("Unregistered resource path"); return logical;
  } } } }));
  const config = { kind: "configured" as const, entries: [{ scopeId: "person", path,
    watch: { kind: "existing" as const, databasePath: watchPath, adoptionReceiptPath: receiptPath, acceptedSpool: input.spool ?? "drain" } }] };
  const plugin = new CoreDuties(config, { scopes: [scope], principals: [principal], policy, owner, enabled: () => true });
  plugins.push(plugin);
  const occurrence = { id: "occurrence-13", requestId: "watch-wake:occurrence-13", title: "Accepted check", cwd: root, message: "Already accepted check", createdBy: { kind: "service" as const } };
  db.prepare("INSERT INTO watch_wake VALUES(?,?)").run(occurrence.id, JSON.stringify(occurrence));
  db.prepare("INSERT INTO watch_item VALUES(?,?)").run("duty-13", JSON.stringify({ id: "duty-13", what: "Check exchange", why: "Known duty", nextDueAt: 13, addedBy: "unknown", createdAt: 1, updatedAt: 1 }));
  return { root, db, plugin, service, config, scope, owner, path, occurrence, watchPath, receiptPath };
}

it("config rejects ambiguous state, mode and duplicate scope/resource paths", () => {
  expect(parseCoreDutiesConfig(undefined).ok).toBe(false);
  expect(parseCoreDutiesConfig({ kind: "disabled" })).toEqual({ ok: true, value: { kind: "disabled" } });
  expect(parseCoreDutiesConfig({ kind: "disabled", entries: [] }).ok).toBe(false);
  expect(parseCoreDutiesConfig({ kind: "configured", entries: [{ scopeId: "a", path: "/notes/../notes/duties.md", watch: { kind: "none" } }] }).ok).toBe(false);
  expect(parseCoreDutiesConfig({ kind: "configured", entries: [{ scopeId: "a", path: "/notes/duties.md", watch: { kind: "existing", databasePath: "/db", adoptionReceiptPath: "/receipt" } }] }).ok).toBe(false);
});

describe("existing duty custody", () => {
  it("adopts exact source data and only the main-clock tick drains the original accepted spool", async () => {
    const { db, plugin, service, path, occurrence } = fixture();
    try {
      expect((await plugin.start()).ok).toBe(true);
      expect(service.get(occurrence.id)).toBeNull();
      expect(readFileSync(path, "utf8")).toContain('"id":"occurrence-13"');
      expect(plugin.receipts()[0]!.pendingOccurrenceIds).toEqual(["occurrence-13"]);
      expect((await plugin.tick()).ok).toBe(true);
      expect(service.pending(occurrence.id).map(message => message.id)).toEqual([occurrence.requestId]);
      expect(db.prepare("SELECT count(*) n FROM watch_wake").get()).toMatchObject({ n: 0 });
      expect(db.prepare("SELECT nextWakeAt FROM watch_schedule").get()).toMatchObject({ nextWakeAt: 123 });
      expect((await plugin.tick()).ok).toBe(true);
      expect(service.snapshot()).toHaveLength(1);
    } finally { db.close(); }
  });
  it("explicit hold and missing dispatch grant leave original spool intact", async () => {
    for (const input of [{ spool: "hold" as const }, { granted: false }]) {
      const { db, plugin, service, occurrence } = fixture(input);
      try {
        expect((await plugin.start()).ok).toBe(true);
        const tick = await plugin.tick();
        expect(tick.ok).toBe(input.granted !== false);
        expect(service.get(occurrence.id)).toBeNull();
        expect(db.prepare("SELECT id FROM watch_wake").get()).toMatchObject({ id: occurrence.id });
      } finally { db.close(); }
    }
  });
  it("held accepted check remains held and original pending spool is not acknowledged away", async () => {
    const { db, plugin, service, occurrence } = fixture();
    try {
      const accepted = await service.spawn(occurrence);
      if (!accepted.ok) throw new Error(accepted.error.message);
      await service.control({ action: "close", threadId: occurrence.id });
      expect((await plugin.start()).ok).toBe(true);
      expect((await plugin.tick()).ok).toBe(true);
      expect(service.get(occurrence.id)?.metadata?.archived).toBe(true);
      expect(db.prepare("SELECT id FROM watch_wake").get()).toMatchObject({ id: occurrence.id });
      expect(service.pending(occurrence.id).map(message => message.id)).toEqual([occurrence.requestId]);
    } finally { db.close(); }
  });
  it("inactive scope is untouched and missing watch tables never create replacement schema", async () => {
    const inactive = fixture({ inactive: true });
    try {
      expect((await inactive.plugin.start()).ok).toBe(true);
      expect(inactive.owner).not.toHaveBeenCalled();
      expect(existsSync(inactive.path)).toBe(false);
      expect((await inactive.plugin.tick()).ok).toBe(true);
      expect(inactive.service.snapshot()).toEqual([]);
    } finally { inactive.db.close(); }
    const corrupt = fixture();
    try {
      corrupt.db.exec("DROP TABLE watch_wake");
      expect((await corrupt.plugin.start()).ok).toBe(false);
      expect(corrupt.db.prepare("SELECT 1 FROM sqlite_master WHERE name='watch_wake'").get()).toBeUndefined();
      expect(existsSync(corrupt.path)).toBe(false);
    } finally { corrupt.db.close(); }
  });
  it("attaches the canonical Markdown path to the existing dispatch-only manager", async () => {
    const { db, plugin, service, scope, path } = fixture();
    try {
      const manager = await service.spawn({ requestId: "manager", title: "Manage", cwd: scope.custody.dataDir, metadata: { manager: true } });
      if (!manager.ok) throw new Error(manager.error.message);
      scope.manager = { kind: "existing", threadId: manager.value.id };
      expect((await plugin.start()).ok).toBe(true);
      expect(service.get(manager.value.id)?.metadata?.markdownDutiesPath).toBe(path);
    } finally { db.close(); }
  });
  it("receipt table names must match exact watch custody", async () => {
    const { db, plugin, receiptPath } = fixture();
    try {
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
      writeFileSync(receiptPath, JSON.stringify({ ...receipt, tableNames: ["unrelated_images"] }), { mode: 0o600 });
      expect((await plugin.start()).ok).toBe(false);
      expect(db.prepare("SELECT id FROM watch_wake").get()).toMatchObject({ id: "occurrence-13" });
    } finally { db.close(); }
  });
});
