import { expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentCapacityAuthority, createAgentCapacityServer } from "../src/agent-capacity-authority.js";
import { configuredCapacityRecovery } from "../src/agent-capacity.js";

test("privileged recovery broker is release-only and exact adopted-scope bound", async () => {
  const root = mkdtempSync(join(tmpdir(), "capacity-broker-")), authority = new AgentCapacityAuthority(":memory:");
  const server = createAgentCapacityServer(authority, [{ id: "root", token: "root-token", host: "a" }, { id: "scope", token: "scope-token", host: "a" }], [{ ownerId: "root", ownerIds: ["root", "scope"] }]);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  authority.initialize([]);
  const execution = { agentId: "adopted", executionId: "original" }, custody = authority.acquire("root", execution);
  if (!custody.ok) throw new Error(custody.error.message);
  const manifest = join(root, "manifest.json"), token = join(root, "root-token"), scopeToken = join(root, "scope-token");
  writeFileSync(token, "root-token", { mode: 0o600 }); writeFileSync(scopeToken, "scope-token", { mode: 0o600 });
  const registration = { authorityUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    owners: [{ uid: 0, ownerId: "root", tokenFile: token }, { uid: 1000, ownerId: "scope", tokenFile: scopeToken }] };
  writeFileSync(manifest, JSON.stringify(registration));
  const recovery = configuredCapacityRecovery({ PI_AGENT_CAPACITY_CONFIG: manifest }, id => id === "adopted");
  try {
    expect((await recovery.recordedOwner(execution)).ok).toBe(false);
    writeFileSync(manifest, JSON.stringify({ ...registration, migration: { ownerId: "root", ownerIds: ["root", "scope"] } }));
    expect((await recovery.recordedOwner({ ...execution, agentId: "foreign" })).ok).toBe(false);
    if (process.getuid!() !== 0) {
      expect((await recovery.recordedOwner(execution)).ok).toBe(false);
      expect(recovery.originalOwner("root", execution).ok).toBe(false);
      return;
    }
    expect(await recovery.recordedOwner(execution)).toEqual({ ok: true, value: "root" });
    const client = recovery.originalOwner("root", execution); if (!client.ok) throw new Error(client.error.message);
    expect("acquire" in client.value).toBe(false);
    expect((await client.value.release({ ...custody.value, executionId: "other" })).ok).toBe(false);
    expect((await client.value.release(custody.value)).ok).toBe(true);
    expect(authority.inspect("root", execution)).toEqual({ ok: true, value: { state: "released" } });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve())); authority.close(); rmSync(root, { recursive: true, force: true });
  }
});
