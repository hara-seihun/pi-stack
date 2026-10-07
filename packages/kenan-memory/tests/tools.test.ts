import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryExtension } from "../src/tools.js";
import { memoryService } from "../src/service.js";
import { MemoryStore } from "../src/store.js";
import { isPrivateMount } from "../src/private-store.js";
function api() {
  const tools: any[] = [], handlers: any[] = [];
  let active = ["read", "bash", "root_reply"];
  return { tools, handlers, registerTool: (tool: unknown) => tools.push(tool), on: (...args: any[]) => handlers.push(args),
    getAllTools: () => tools, getActiveTools: () => active, setActiveTools: (names: string[]) => { active = names; } };
}
test("an already-open flag-off session loads authenticated authority before the turn and rolls back its toolset", async () => {
  const root = mkdtempSync(join(tmpdir(), "memory-lazy-")); const path = join(root, "host.json"); writeFileSync(path, "{}");
  const store = new MemoryStore(":memory:");
  const server = memoryService({ store, auth: { supervisors: [], uidPersons: { "12345": "bob" } }, peerUid: () => 12345, enabled: () => true });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const env: NodeJS.ProcessEnv = { PI_STACK_HOST_CONFIG: path, PI_THREAD_ID: "b", PI_KENAN_MEMORY_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
  const pi = api();
  try {
    memoryExtension({ env, ask: async () => ({}) })(pi as any);
    const before = pi.handlers.find(h => h[0] === "before_agent_start")[1];
    expect(await before({ systemPrompt: "base" })).toBeUndefined();
    expect(pi.tools).toHaveLength(0);
    expect(store.db.query("SELECT count(*) AS count FROM sessions").get()).toEqual({ count: 0 });
    writeFileSync(path, JSON.stringify({ oneKenan: true }));
    expect((await before({ systemPrompt: "base" })).systemPrompt).toBeTypeOf("string");
    expect(env.PI_KENAN_MEMORY_PERSON).toBe("bob");
    expect(store.db.query("SELECT count(*) AS count FROM sessions").get()).toEqual({ count: 1 });
    expect(pi.getActiveTools()).toContain("life_policy");
    expect(pi.getActiveTools()).toContain("ask_kenan"); expect(pi.getActiveTools()).toContain("root_reply");
    const found = await pi.tools.find(t => t.name === "memory_search").execute("id", { query: "" });
    expect(found.details.kenanMemoryRead).toMatchObject({ person: "bob", threadId: "b", touchedOtherPeople: false });
    expect(env.PI_KENAN_MEMORY_PERSON).toBe("bob"); expect(env.PI_KENAN_MEMORY_ROLE).toBe("person");
    writeFileSync(path, "{}"); await before({ systemPrompt: "base" });
    expect(pi.getActiveTools()).toEqual(["read", "bash", "root_reply"]);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); rmSync(root, { recursive: true, force: true }); }
});
test("room registers only ask; root preserves fixed nonmemory tools and exposes no recursive ask", async () => {
  const root = mkdtempSync(join(tmpdir(), "memory-role-")); const path = join(root, "host.json"); writeFileSync(path, JSON.stringify({ oneKenan: true }));
  try {
    const make = async (role: string, room = false) => {
      const pi = api();
      memoryExtension({ env: { PI_STACK_HOST_CONFIG: path, PI_THREAD_ID: "session", PI_KENAN_MEMORY_PERSON: room ? "pi-rooms" : "bob", PI_KENAN_MEMORY_ROLE: role, PI_KENAN_MEMORY_TOKEN: "verified", ...(room ? { PI_REMOTE_ROOMS_RUNTIME: "1" } : {}) }, lifeClient: { request: async () => ({ ok: false, error: "unavailable", message: "Test authority unavailable" }) }, ask: async () => ({}) })(pi as any);
      await pi.handlers.find(h => h[0] === "before_agent_start")[1]({ systemPrompt: "fixed" }); return pi;
    };
    const room = await make("person", true); expect(room.tools.map(t => t.name)).toEqual(["ask_kenan"]);
    const privileged = await make("root"); expect(privileged.tools.some(t => t.name === "ask_kenan")).toBe(false);
    expect(privileged.getActiveTools()).toContain("root_reply"); expect(privileged.getActiveTools()).toContain("bash"); expect(privileged.getActiveTools()).toContain("memory_read");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("production admission requires a real gocryptfs mount, not just a directory or bind mount", () => {
  expect(isPrivateMount("/private", "20 1 0:5 / /private rw - fuse.gocryptfs cipher rw\n")).toBe(true);
  expect(isPrivateMount("/private", "20 1 0:5 / /private rw - ext4 disk rw\n")).toBe(false);
  expect(isPrivateMount("/private", "20 1 0:5 / /another rw - fuse.gocryptfs cipher rw\n")).toBe(false);
});
