import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test, mock, spyOn } from "bun:test";
import type { CoreConfig, CoreScope } from "../src/core/contracts.js";
import { ThreadService } from "../src/threads/service.js";
import { threadCapability } from "../src/threads/caller.js";
import * as custodyModule from "../src/core/custody.js";
import * as callbackModule from "../src/core/callback-transports.js";
import { serveCore } from "../src/core/main.js";
const factory = mock(), callbacks = mock(), closed = mock(), openSession = mock();
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); mock.restore(); });

test("a checksum mismatch starts Core, callbacks and scoped routes without dispatching original recurring wakes", async () => {
  spyOn(custodyModule, "createCoreCustodyFactory").mockReturnValue(factory);
  spyOn(callbackModule, "startCallbackTransports").mockImplementation(callbacks);
  const root = mkdtempSync(join(tmpdir(), "core-duty-startup-")); roots.push(root);
  const sessionsDir = join(root, "sessions"); mkdirSync(sessionsDir);
  const databasePath = join(root, "threads.sqlite"), capabilityKeyPath = join(root, "capability"), adoptionReceiptPath = join(root, "thread-custody.json");
  const capability = threadCapability(capabilityKeyPath);
  const old = new ThreadService({ databasePath, sessionsDir, capability, capacity: { mode: "unmanaged" }, openSession });
  const created = await old.spawn({ id: "manager", requestId: "original-manager", cwd: root, title: "Recurring manager", metadata: { manager: true } });
  if (!created.ok) throw new Error(created.error.message);
  capability.issue(created.value.id);
  const db = new DatabaseSync(databasePath);
  const schedule = { reason: "Original duty", cadenceMs: 60000, nextDueAt: 0, lastMessageId: null };
  db.prepare("INSERT INTO thread_wake(thread_id,generation,data) VALUES(?,?,?)").run(created.value.id, "original-generation", JSON.stringify(schedule));
  const snapshot = { version: 1, wakes: old.exportWakeDuties(), watches: null, owners: {} };
  const receipt = `markdown-duties:${createHash("sha256").update(JSON.stringify(snapshot)).digest("hex")}`;
  snapshot.wakes[0]!.title = "Changed historical hold";
  const path = join(root, "duties.md");
  const bytes = `# Current duties\n\nHeld: current instruction stays.\n\n<!-- pi-stack-duties-custody:start -->\n\`\`\`json\n${JSON.stringify({ receipt, snapshot })}\n\`\`\`\n<!-- pi-stack-duties-custody:end -->\n`;
  writeFileSync(path, bytes);
  expect((await old.detach()).ok).toBe(true);
  const stat = statSync(databasePath, { bigint: true });
  writeFileSync(adoptionReceiptPath, JSON.stringify({ version: 1, state: "detached", scopeId: "person", databasePath, sessionsDir,
    databaseIdentity: { dev: String(stat.dev), ino: String(stat.ino) }, previousOwner: { identity: "fixture-original-owner", detachedAt: new Date().toISOString() } }), { mode: 0o600 });
  const resource = { id: "person-threads", kind: "thread", owner: "person", privacy: "private", subjects: ["person"], consent: "not-required" } as const;
  const scope: CoreScope = { id: "person", principalId: "person", availability: { kind: "adopt" }, resource,
    storage: { databasePath, sessionsDir, capabilityKeyPath, adoptionReceiptPath },
    custody: { uid: process.getuid!(), gid: process.getgid!(), namespace: { kind: "host" }, retainedRunnerNamespace: { kind: "host" }, dataDir: root, socketDir: root },
    resources: [{ kind: "directory", path: root }], environment: {}, callbackGateway: { kind: "none" }, manager: { kind: "none" }, managerRouting: { kind: "none" } };
  const config: CoreConfig = { version: 1, host: "127.0.0.1", port: 0, statePath: join(root, "core.sqlite"), releaseCommit: "a".repeat(40),
    scopes: [scope], principals: [{ kind: "person", id: "person", person: "person" }],
    credentials: [{ sha256: createHash("sha256").update("synthetic-token").digest("hex"), principalId: "person", scopeIds: ["person"], purpose: "service", routeCeiling: { kind: "scoped" } }],
    policy: { revision: 1, grants: [{ id: "read-person", principal: "person", resource: { kind: "exact", id: resource.id }, actions: ["read", "dispatch"], effect: "allow", validFrom: 0, validUntil: null, issuedBy: "person", source: "fixture grant" }], consents: [] },
    broker: { kind: "disabled" }, root: { kind: "disabled" }, memory: { kind: "disabled" }, images: { kind: "disabled" },
    duties: { kind: "configured", entries: [{ scopeId: scope.id, path, watch: { kind: "none" } }] }, callbacks: { kind: "none" }, gatewayTransport: { kind: "none" }, gatewayBindings: [] };
  factory.mockResolvedValue({ ok: true, value: { path: (path: string) => path, openSession, attachSession: async () => null, recoverSession: async () => null, detach() {},
    readImage: async () => ({ ok: false, error: { code: "unavailable", message: "Fixture has no image reader" } }) } });
  callbacks.mockResolvedValue({ ok: true, value: { close: closed.mockResolvedValue(undefined) } });
  config.port = 20000 + Math.floor(Math.random() * 30000);
  const started = await serveCore(config);
  if (!started.ok) throw new Error(started.error.message);
  expect(started.ok).toBe(true);
  try {
    expect(callbacks).toHaveBeenCalledOnce();
    const health = await fetch(`${started.value.service.url}/v1/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ready: true, degraded: true, reconciliation: { duties: "custody-degraded", dutyCustodyErrors: [{ scopeId: "person", stage: "markdown", error: { code: "invalid_request" } }] } });
    const projection = await fetch(`${started.value.service.url}/v1/scopes/person/projection`, { headers: { authorization: "Bearer synthetic-token" } });
    expect(projection.status).toBe(200);
    expect(readFileSync(path, "utf8")).toBe(bytes);
    expect(db.prepare("SELECT generation,data FROM thread_wake").get()).toMatchObject({ generation: "original-generation", data: JSON.stringify(schedule) });
    expect(db.prepare("SELECT count(*) n FROM thread_work WHERE id LIKE 'thread-wake:%'").get()).toMatchObject({ n: 0 });
    expect(openSession).not.toHaveBeenCalled();
  } finally { expect((await started.value.close()).ok).toBe(true); db.close(); }
  expect(closed).toHaveBeenCalledOnce();
});
