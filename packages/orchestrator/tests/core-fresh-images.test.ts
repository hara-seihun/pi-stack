import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CoreProvisionRegistration } from "../src/core/provision.js";
import { CoreImages, parseCoreImagesConfig } from "../src/core/images.js";
import { Store } from "../src/store.js";
import type { Thread } from "../src/threads/contracts.js";

// Real finite UID worker followed by the unchanged adoption consumer: no image provider call.
test("fresh UID provisioned registry serves images through the canonical adoption owner", async () => {
  const root = mkdtempSync(join(tmpdir(), "core-fresh-images-")), directory = join(root, "fresh");
  const registry = { scopeId: "person-alice", databasePath: join(directory, "images.sqlite3"), artifactRoot: join(directory, "images"), adoptionReceiptPath: join(directory, "image-adoption.json"), allowedRoots: [root], relatedThreadScopeIds: [],
    dataResource: { id: "alice-images", kind: "data" as const, owner: "alice", privacy: "private" as const, subjects: ["alice"], consent: "not-required" as const } };
  const registration: CoreProvisionRegistration = { id: "register-alice", requestId: "register-alice-create", creatorPrincipalId: "registrar", source: "Explicit account creation fixture authority",
    operation: { id: "create", kind: "operation", owner: "registrar", privacy: "private", subjects: [], consent: "not-required" }, directory,
    scope: { id: registry.scopeId, principalId: "alice", availability: { kind: "adopt" }, resource: { id: "alice-threads", kind: "thread", owner: "alice", privacy: "private", subjects: ["alice"], consent: "not-required" },
      storage: { databasePath: join(directory, "threads.sqlite3"), sessionsDir: join(directory, "sessions"), capabilityKeyPath: join(directory, "key"), adoptionReceiptPath: join(directory, "adoption.json") },
      custody: { uid: process.getuid!(), gid: process.getgid!(), namespace: { kind: "host" }, retainedRunnerNamespace: { kind: "host" }, dataDir: directory, socketDir: root },
      resources: [{ path: root, kind: "directory" }, { path: `/run/pi-stack/session-writers/${process.getuid!()}`, kind: "directory" }, { path: `/run/pi-stack/native-runner-locks/${process.getuid!()}`, kind: "directory" }],
      environment: { PI_SESSION_WRITER_DIRECTORY: `/run/pi-stack/session-writers/${process.getuid!()}`, PI_SESSION_WRITER_SCOPE: registry.scopeId, PI_NATIVE_RUNNER_DATA_DIR: directory, PI_NATIVE_RUNNER_UID: String(process.getuid!()) }, callbackGateway: { kind: "none" }, manager: { kind: "existing", threadId: "alice-manager" }, managerRouting: { kind: "none" } },
    manager: { cwd: root, settings: { model: "sol", speed: "ultrafast", thinkingLevel: "low" } }, markdown: { kind: "none" }, images: { kind: "fresh", priorOwner: { kind: "none" }, registry } };
  const payload = { registration, input: { registrationId: registration.id, requestId: registration.requestId }, actor: "registrar", namespaceInode: statSync("/proc/self/ns/mnt", { bigint: true }).ino.toString(),
    principals: [{ id: "registrar", kind: "service" }, { id: "alice", kind: "person", person: "alice" }],
    policy: { revision: 1, consents: [], grants: [
      { id: "create", principal: "registrar", resource: { kind: "exact", id: "create" }, actions: ["execute"] },
      { id: "threads", principal: "alice", resource: { kind: "exact", id: "alice-threads" }, actions: ["read", "dispatch", "control"] },
      { id: "images", principal: "alice", resource: { kind: "exact", id: "alice-images" }, actions: ["read", "execute", "use"] },
    ].map(grant => ({ ...grant, effect: "allow", validFrom: 0, validUntil: null, issuedBy: "registrar", source: "Explicit original account template" })) } };
  let images: CoreImages | undefined, accounts: Store | undefined;
  try {
    const worker = fileURLToPath(new URL("../src/core/provision-worker.ts", import.meta.url));
    const result = spawnSync(process.execPath, [worker], { input: JSON.stringify(payload), encoding: "utf8", env: { ...process.env, ...registration.scope.environment }, timeout: 15_000 });
    expect(result.status).toBe(0); expect(JSON.parse(result.stdout).ok).toBe(true);
    expect(parseCoreImagesConfig({ kind: "configured", registries: [registry] }).ok).toBe(true);
    const native = join(registration.scope.storage.sessionsDir, "alice-manager.jsonl");
    const source = join(root, "reference.png"); writeFileSync(source, Buffer.from("89504e470d0a1a0a", "hex"));
    writeFileSync(native, JSON.stringify({ type: "session", version: 3, id: "fresh", timestamp: new Date().toISOString(), cwd: root }) + "\n"
      + JSON.stringify({ type: "message", id: "first", parentId: null, message: { role: "assistant", content: [{ type: "text", text: `<pi-remote-image id="first-image" path="${source}" />` }], timestamp: Date.now() } }) + "\n");
    accounts = Store.open(join(root, "provider.sqlite3"));
    images = new CoreImages({ kind: "configured", registries: [registry] }, {
      accounts: { store: accounts, shared: undefined },
      scope: () => ({ ok: true, value: { uid: process.getuid!(), gid: process.getgid!(), allowsThread: id => id === "alice-manager",
        runtime: { path: path => path, readImage: async path => path === source ? { ok: true, value: readFileSync(source) } : { ok: false, error: { code: "unavailable", message: "Outside fixture reference grant" } } },
        threads: { snapshot: () => [{ id: "alice-manager", sessionFile: native } as Thread], subscribe: () => () => {} } } }),
      relatedScope: () => ({ ok: false, error: { code: "invalid-config", message: "No related scopes registered" } }),
      authorize: () => ({ ok: true, value: undefined }), authorizeNative: () => ({ ok: true, value: undefined }),
    });
    expect((await images.start()).ok).toBe(true);
    const request = new Request("http://core.test/v1/scopes/person-alice/images/accept", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId: "alice-manager", messageKey: "first", text: "First finalized output" }) });
    const accepted = await images.handle(request); expect(accepted?.status).toBe(200);
    expect(await accepted?.json()).toMatchObject({ ok: true, value: { images: [{ id: "first-image" }] } });
    const adoptedInode = statSync(registry.databasePath).ino;
    const retry = spawnSync(process.execPath, [worker], { input: JSON.stringify(payload), encoding: "utf8", env: { ...process.env, ...registration.scope.environment }, timeout: 15_000 });
    expect(retry.status).toBe(0); expect(statSync(registry.databasePath).ino).toBe(adoptedInode);
    const wrongScope = spawnSync(process.execPath, [worker], { input: JSON.stringify(payload), encoding: "utf8", env: { ...process.env, ...registration.scope.environment, PI_SESSION_WRITER_SCOPE: "foreign" }, timeout: 15_000 });
    expect(wrongScope.status).not.toBe(0); expect(JSON.parse(wrongScope.stdout).ok).toBe(false);
  } finally { await images?.close(); accounts?.close(); rmSync(root, { recursive: true, force: true }); }
});
