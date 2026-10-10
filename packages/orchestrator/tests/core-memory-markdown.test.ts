import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "kenan-memory/store";
import { createMemoryMarkdown, type MarkdownOwner } from "../src/core/memory-markdown.js";
import type { CoreScope } from "../src/core/contracts.js";
import type { PermissionPolicy } from "../src/permissions.js";
const note = (value: unknown) => `# Note\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\n`;
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "core-markdown-")), store = new MemoryStore(":memory:");
  const processStat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
  const namespace = { kind: "process" as const, pid: process.pid, startTicks: processStat.slice(processStat.lastIndexOf(")") + 2).split(/\s+/)[19]!, mountNamespaceInode: statSync(`/proc/${process.pid}/ns/mnt`, { bigint: true }).ino.toString() };
  const owners: MarkdownOwner[] = ["alice", "bob"].map(subject => ({ subject, custodyScopeId: subject, folder: join(directory, subject), resource: { id: `${subject}-memory`, kind: "memory", owner: subject, privacy: "private", subjects: [subject], consent: "not-required" } }));
  for (const owner of owners) mkdirSync(owner.folder);
  const scopes: CoreScope[] = owners.map(owner => ({ id: owner.subject, principalId: owner.subject, availability: { kind: "adopt" }, resource: { ...owner.resource, kind: "data" }, storage: { databasePath: join(owner.folder, "thread.sqlite3"), adoptionReceiptPath: join(owner.folder, "receipt.json"), sessionsDir: owner.folder, capabilityKeyPath: join(owner.folder, "key") }, custody: { uid: process.getuid!(), gid: process.getgid!(), namespace, retainedRunnerNamespace: namespace, dataDir: owner.folder, socketDir: owner.folder }, resources: [], environment: {}, callbackGateway: { kind: "none" }, manager: { kind: "none" }, managerRouting: { kind: "none" } }));
  const policy: PermissionPolicy = { revision: 1, consents: [], grants: owners.map(owner => ({ id: owner.subject, principal: "maintenance", resource: { kind: "exact", id: owner.resource.id }, actions: ["read", "invalidate"], effect: "allow", validFrom: 0, validUntil: null, issuedBy: "fixture", source: "explicit maintenance only" })) };
  const options = { owners, scopes, policy, maintenance: { kind: "service" as const, id: "maintenance" }, store, signatureKey: "fixture-custody-signing-key-32-bytes", owner: (scopeId: string) => ({ ok: true as const, value: { runtime: { path: (logical: string) => { if (logical !== owners.find(owner => owner.subject === scopeId)?.folder) throw new Error("Unregistered path"); return logical; } } } }) };
  return { options, close() { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}
test("dependency invalidation uses service grants without copying another owner's plaintext or identifiers", () => {
  const f = fixture(), { options } = f;
  try {
    const source = options.store.write("alice", { text: "Alice private source", about: ["alice"], obviouslyPrivate: true, source: { saidBy: "alice" }, setting: { person: "alice", threadId: "own" } });
    writeFileSync(join(options.owners[0]!.folder, "source.md"), note({ id: source.id, body: JSON.stringify(source) }));
    writeFileSync(join(options.owners[1]!.folder, "derived.md"), note({ id: "bob-secret-conclusion", provenance: { factClass: "derived", evidence: [{ kind: "memory", id: source.id }] } }));
    const built = createMemoryMarkdown(options); if (!built.ok) throw new Error(built.error.message);
    try {
      expect(built.value.forget({ kind: "person", id: "alice", person: "alice" }, [source.id], "delete").ok).toBe(true);
      expect(existsSync(join(options.owners[1]!.folder, "derived.md"))).toBe(false);
      const aliceExclusions = readFileSync(join(options.owners[0]!.folder, "FORGOTTEN.md"), "utf8");
      expect(aliceExclusions).not.toContain("bob-secret-conclusion");
      expect(readFileSync(join(options.owners[1]!.folder, "FORGOTTEN.md"), "utf8")).not.toContain("Alice private source");
    } finally { built.value.close(); }
  } finally { f.close(); }
});
test("missing maintenance grants fence active use and leave source unchanged; locked descriptors never touch their folders", () => {
  const f = fixture(), { options } = f;
  try {
    options.scopes[1]!.availability = { kind: "unavailable", reason: "locked" };
    let lockedAccess = false;
    const baseOwner = options.owner;
    options.owner = scopeId => { if (scopeId === "bob") lockedAccess = true; return baseOwner(scopeId); };
    options.policy = { revision: 1, consents: [], grants: [] };
    const source = options.store.write("alice", { text: "Alice private source", about: ["alice"], obviouslyPrivate: true, source: { saidBy: "alice" }, setting: { person: "alice", threadId: "own" } });
    const built = createMemoryMarkdown(options); if (!built.ok) throw new Error(built.error.message);
    try {
      expect(built.value.forget({ kind: "person", id: "alice", person: "alice" }, [source.id], "delete")).toMatchObject({ ok: false, error: "unavailable" });
      expect(built.value.fenced(["alice"])).toBe(true);
      expect(built.value.fenced(["bob"])).toBe(true);
      expect(options.store.authorizationItems([source.id])).toHaveLength(1);
      expect(readFileSync(join(options.owners[0]!.folder, "FORGET-PENDING.md"), "utf8")).not.toContain("Alice private source");
      expect(lockedAccess).toBe(false);
    } finally { built.value.close(); }
  } finally { f.close(); }
});
