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
function fixture(input: { spool?: "hold" | "drain"; granted?: boolean; inactive?: boolean; scopeId?: string } = {}) {
  const scopeId = input.scopeId ?? "person";
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
  writeFileSync(receiptPath, JSON.stringify({ version: 1, state: "detached", scopeId: `${scopeId}:watch`, databasePath: watchPath,
    databaseIdentity: { dev: String(identity.dev), ino: String(identity.ino) }, tableNames: WATCH_CUSTODY_TABLES,
    previousOwner: { identity: "original-supervisor", detachedAt: "2026-10-10T20:00:00Z" } }), { mode: 0o600 });
  const service = new ThreadService({ databasePath: join(root, "threads.sqlite"), sessionsDir: root, capacity: { mode: "unmanaged" }, openSession: vi.fn() });
  services.push(service);
  const resource = { id: `${scopeId}-threads`, kind: "thread", owner: scopeId, privacy: "private", subjects: [scopeId], consent: "not-required" } as const;
  const scope: CoreScope = { id: scopeId, principalId: scopeId, availability: input.inactive ? { kind: "unavailable", reason: "inactive" } : { kind: "adopt" }, resource,
    storage: { databasePath: join(root, "threads.sqlite"), sessionsDir: root, capabilityKeyPath: join(root, "capability"), adoptionReceiptPath: join(root, "thread-receipt") },
    custody: { uid: process.getuid!(), gid: process.getgid!(), namespace: { kind: "host" }, retainedRunnerNamespace: { kind: "host" }, dataDir: root, socketDir: root },
    resources: [{ path: root, kind: "directory" }], environment: {}, callbackGateway: { kind: "none" }, manager: { kind: "none" }, managerRouting: { kind: "none" } };
  const principal: Principal = { kind: "person", id: scopeId, person: scopeId };
  const policy: PermissionPolicy = { revision: 1, grants: input.granted === false ? [] : [{ id: `${scopeId}-dispatch`, principal: scopeId, resource: { kind: "exact", id: resource.id },
    actions: ["dispatch"], effect: "allow", validFrom: 0, validUntil: null, issuedBy: scopeId, source: "test grant" }], consents: [] };
  const owner = vi.fn(() => ({ ok: true as const, value: { threads: service, runtime: { path: (logical: string) => {
    if (logical !== root && !logical.startsWith(root + "/")) throw new Error("Unregistered resource path"); return logical;
  } } } }));
  const config = { kind: "configured" as const, entries: [{ scopeId, path,
    watch: { kind: "existing" as const, databasePath: watchPath, adoptionReceiptPath: receiptPath, acceptedSpool: input.spool ?? "drain" } }] };
  const plugin = new CoreDuties(config, { scopes: [scope], principals: [principal], policy, owner, enabled: () => true });
  plugins.push(plugin);
  const occurrence = { id: "occurrence-13", requestId: "watch-wake:occurrence-13", title: "Accepted check", cwd: root, message: "Already accepted check", createdBy: { kind: "service" as const } };
  db.prepare("INSERT INTO watch_wake VALUES(?,?)").run(occurrence.id, JSON.stringify(occurrence));
  db.prepare("INSERT INTO watch_item VALUES(?,?)").run("duty-13", JSON.stringify({ id: "duty-13", what: "Check exchange", why: "Known duty", nextDueAt: 13, addedBy: "unknown", createdAt: 1, updatedAt: 1 }));
  return { root, db, plugin, service, config, scope, principal, policy, owner, path, occurrence, watchPath, receiptPath };
}

it("config rejects ambiguous state, mode and duplicate scope/resource paths", () => {
  expect(parseCoreDutiesConfig(undefined).ok).toBe(false);
  expect(parseCoreDutiesConfig({ kind: "disabled" })).toEqual({ ok: true, value: { kind: "disabled" } });
  expect(parseCoreDutiesConfig({ kind: "disabled", entries: [] }).ok).toBe(false);
  expect(parseCoreDutiesConfig({ kind: "configured", entries: [{ scopeId: "a", path: "/notes/../notes/duties.md", watch: { kind: "none" } }] }).ok).toBe(false);
  expect(parseCoreDutiesConfig({ kind: "configured", entries: [{ scopeId: "a", path: "/notes/duties.md", watch: { kind: "existing", databasePath: "/db", adoptionReceiptPath: "/receipt" } }] }).ok).toBe(false);
});

describe("existing duty custody", () => {
  it("binds the exact adopted reader without admitting new mutations or replaying accepted work", async () => {
    const { db, plugin, service, occurrence } = fixture({ spool: "hold" });
    try {
      const list = { action: "list" as const, threadId: "manager" };
      expect(await service.watch(list)).toMatchObject({ ok: false, error: { code: "unavailable" } });
      expect((await plugin.start()).ok).toBe(true);
      expect(await service.watch(list)).toMatchObject({ ok: true, value: { items: [{ id: "duty-13" }] } });
      expect(await service.watch({ action: "update", threadId: "manager", requestId: "new-update", id: "duty-13", patch: { nextDueAt: 99 } }))
        .toMatchObject({ ok: false, error: { code: "invalid_request", message: expect.stringContaining("Markdown") } });
      expect(db.prepare("SELECT body FROM watch_item").get()).toMatchObject({ body: expect.stringContaining('"nextDueAt":13') });
      expect(db.prepare("SELECT count(*) n FROM watch_request").get()).toMatchObject({ n: 0 });
      expect(db.prepare("SELECT id FROM watch_wake").get()).toMatchObject({ id: occurrence.id });
      expect(service.snapshot()).toEqual([]);
      const closing = plugin.close();
      expect(await service.watch(list)).toMatchObject({ ok: false, error: { code: "unavailable", message: expect.stringContaining("no unlocked watch list owner") } });
      await closing;
      await plugin.close();
    } finally { db.close(); }
  });
  it("never exposes a candidate after Markdown or manager-pointer adoption fails", async () => {
    for (const failure of ["markdown", "manager"] as const) {
      const { db, plugin, service, config, scope, root, occurrence } = fixture();
      try {
        if (failure === "markdown") {
          const parent = join(root, "file"); writeFileSync(parent, "not a directory");
          config.entries[0]!.path = join(parent, "duties.md");
        } else scope.manager = { kind: "existing", threadId: "missing-manager" };
        expect((await plugin.start()).ok).toBe(false);
        expect(await service.watch({ action: "list", threadId: "manager" })).toMatchObject({ ok: false, error: { code: "unavailable" } });
        expect(db.prepare("SELECT id FROM watch_wake").get()).toMatchObject({ id: occurrence.id });
        expect(service.snapshot()).toEqual([]);
      } finally { db.close(); }
    }
  });
  it("keeps each scope's reader isolated and rolls back earlier bindings if a later scope fails", async () => {
    const first = fixture({ scopeId: "first" }), second = fixture({ scopeId: "second" });
    const combined = () => {
      const plugin = new CoreDuties({ kind: "configured", entries: [...first.config.entries, ...second.config.entries] }, {
        scopes: [first.scope, second.scope], principals: [first.principal, second.principal],
        policy: { revision: 1, grants: [...first.policy.grants, ...second.policy.grants], consents: [] },
        owner: id => id === "first" ? first.owner() : second.owner(), enabled: () => true,
      });
      plugins.push(plugin); return plugin;
    };
    try {
      second.db.prepare("UPDATE watch_item SET body=?").run(JSON.stringify({ id: "second-duty", what: "Second", why: "Isolated", nextDueAt: 22, addedBy: "unknown", createdAt: 1, updatedAt: 1 }));
      const success = combined();
      expect((await success.start()).ok).toBe(true);
      expect(await first.service.watch({ action: "list", threadId: "manager" })).toMatchObject({ ok: true, value: { items: [{ id: "duty-13" }] } });
      expect(await second.service.watch({ action: "list", threadId: "manager" })).toMatchObject({ ok: true, value: { items: [{ id: "second-duty" }] } });
      await success.close();
      second.scope.manager = { kind: "existing", threadId: "missing-manager" };
      expect((await combined().start()).ok).toBe(false);
      for (const fixture of [first, second]) {
        expect(await fixture.service.watch({ action: "list", threadId: "manager" })).toMatchObject({ ok: false, error: { code: "unavailable" } });
        expect(fixture.db.prepare("SELECT id FROM watch_wake").get()).toMatchObject({ id: fixture.occurrence.id });
      }
    } finally { first.db.close(); second.db.close(); }
  });
  it("releases only its own API binding when another provider has replaced it", async () => {
    const { db, plugin, service } = fixture();
    try {
      expect((await plugin.start()).ok).toBe(true);
      const replacement = { watch: vi.fn(async () => ({ ok: true as const, value: { items: [] } })) };
      const unbind = service.setWatchList(replacement);
      await plugin.close();
      expect(await service.watch({ action: "list", threadId: "manager" })).toEqual({ ok: true, value: { items: [] } });
      expect(replacement.watch).toHaveBeenCalledOnce();
      unbind(); unbind();
      expect(await service.watch({ action: "list", threadId: "manager" })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    } finally { db.close(); }
  });
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
