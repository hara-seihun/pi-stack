import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credential } from "../src/config.js";
import { prepareMemoryEnvironment } from "../src/session.js";
import { memoryService } from "../src/service.js";
import { fixtureAuthorization } from "./authorization.js";
import { MemoryStore } from "../src/store.js";

test("existing folder credential without new memory credential still mints a verified UID session", async () => {
  const root = mkdtempSync(join(tmpdir(), "credential-cutover-"));
  const store = new MemoryStore(":memory:");
  const server = memoryService({ authorize: fixtureAuthorization, store, auth: { supervisors: [], uidPersons: { "64000": "alice" } }, enabled: () => true, peerUid: () => 64000 });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const host = join(root, "host.json"); writeFileSync(host, '{"oneKenan":true}');
    writeFileSync(join(root, "folder-key"), "not-a-memory-token");
    const env: NodeJS.ProcessEnv = { PI_STACK_HOST_CONFIG: host, CREDENTIALS_DIRECTORY: root,
      PI_KENAN_MEMORY_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
    expect(credential(env)).toBeUndefined();
    expect(await prepareMemoryEnvironment(env, "thread-a")).toMatchObject({ ok: true, value: { person: "alice", role: "person", threadId: "thread-a" } });
    expect(store.resolveSession(env.PI_KENAN_MEMORY_TOKEN!)).toEqual({ person: "alice", role: "person", threadId: "thread-a" });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve())); store.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("only ENOENT on the implicit credential is optional; explicit and malformed credentials fail", () => {
  const root = mkdtempSync(join(tmpdir(), "credential-config-"));
  try {
    const missing = join(root, "missing");
    for (const name of ["PI_KENAN_MEMORY_SUPERVISOR_TOKEN_FILE", "PI_KENAN_MEMORY_PUBLISHER_TOKEN_FILE"]) {
      expect(() => credential({ [name]: missing, CREDENTIALS_DIRECTORY: root })).toThrow();
    }
    mkdirSync(join(root, "kenan-memory-supervisor"));
    expect(() => credential({ CREDENTIALS_DIRECTORY: root })).toThrow();
    rmSync(join(root, "kenan-memory-supervisor"), { recursive: true });
    writeFileSync(join(root, "kenan-memory-supervisor"), "supervisor-capability\n");
    expect(credential({ CREDENTIALS_DIRECTORY: root })).toBe("supervisor-capability");
    expect(credential({ PI_KENAN_MEMORY_TOKEN: "session", PI_KENAN_MEMORY_SUPERVISOR_TOKEN_FILE: missing })).toBe("session");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
