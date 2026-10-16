import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../src/store.js";
import { projectForget, recoverForget, memoryUseFenced, forgottenIds } from "../src/forget-projection.js";
import { renderAuthority } from "../src/authority.js";
import { MEMORY_FOLDER_AGENTS, MEMORY_FOLDER_README, memoryFolderPrompt } from "../src/markdown.js";
const key = "fixture-private-custody-key-32-bytes";
const jsonNote = (value: unknown) => `# Provenance\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
function fixture(inferred: boolean) {
  const folder = mkdtempSync(join(tmpdir(), "forget-projection-")), store = new MemoryStore(":memory:");
  mkdirSync(join(folder, "records"));
  writeFileSync(join(folder, "README.md"), MEMORY_FOLDER_README); writeFileSync(join(folder, "AGENTS.md"), MEMORY_FOLDER_AGENTS);
  const item = store.write("alice", { text: "Unique forgotten fixture fact", about: ["alice"], obviouslyPrivate: true, source: { saidBy: "alice" }, setting: { person: "alice", threadId: "thread" } });
  writeFileSync(join(folder, "records", "source.md"), jsonNote({ id: item.id, body: JSON.stringify(item) }));
  writeFileSync(join(folder, "records", "derived.md"), jsonNote({ id: "derived", value: { title: "Derived fact", provenance: { factClass: "derived", evidence: [{ kind: "memory", id: item.id }] } } }));
  writeFileSync(join(folder, "records", "hypothesis.md"), jsonNote({ id: "hypothesis", value: { provenance: { factClass: "hypothesis", evidence: [{ kind: "life", id: "derived" }] } } }));
  writeFileSync(join(folder, "work.md"), `# Work\n\n${item.text}\n\n- [source](records/source.md)\n- [derived](records/derived.md)\n- [hypothesis](records/hypothesis.md)\n\nIndependent current task\n`);
  writeFileSync(join(folder, "authority.md"), renderAuthority({ format: "markdown-authority-v1", subject: "alice", source: "fixture", revision: 1, policy: { status: "active", delegation: "Explicit fixture authority", provenance: { factClass: inferred ? "derived" : "stated", validFrom: null, validUntil: null, evidence: [{ kind: "memory", id: item.id }] } } }));
  return { folder, store, item, close() { store.close(); rmSync(folder, { recursive: true, force: true }); } };
}
test("forget removes active text/index and transitive derived/hypothesis claims, revoking inferred but not independent stated authority", () => {
  for (const inferred of [true, false]) {
    const f = fixture(inferred);
    try {
      const result = projectForget({ folders: [{ path: f.folder, subject: "alice" }], items: [f.item], invalidated: [], metadataReadable: true, includeText: () => true, mode: "stop-using", signatureKey: key, commit: (ids, mode) => f.store.forget(ids, mode) });
      expect(result.ok).toBe(true); expect(memoryUseFenced(f.folder)).toBe(false);
      for (const file of ["source.md", "derived.md", "hypothesis.md"]) expect(existsSync(join(f.folder, "records", file))).toBe(false);
      expect(readFileSync(join(f.folder, "work.md"), "utf8")).not.toContain(f.item.text);
      expect(readFileSync(join(f.folder, "work.md"), "utf8")).toContain("Independent current task");
      expect(forgottenIds(f.folder)).toContain("note:alice:hypothesis");
      expect(existsSync(join(f.folder, "authority.md"))).toBe(!inferred);
      const prompt = memoryFolderPrompt(f.folder); expect(prompt.ok).toBe(true);
      if (prompt.ok) expect(prompt.value.includes("Explicit fixture authority")).toBe(!inferred);
      expect(f.store.authorizationItems([f.item.id])).toHaveLength(1);
      expect(f.store.read("alice", { threadId: "thread", turnId: "turn" }, [f.item.id]).value).toHaveLength(0);
    } finally { f.close(); }
  }
});
test("partial failure fences current head and retrieves only after restart-safe signed recovery; forged fences cannot mutate custody", () => {
  const f = fixture(true);
  try {
    const result = projectForget({ folders: [{ path: f.folder, subject: "alice" }], items: [f.item], invalidated: [], metadataReadable: true, includeText: () => true, mode: "delete", signatureKey: key, commit: () => { throw new Error("Fixture interruption before source commit"); } });
    expect(result.ok).toBe(false); expect(memoryUseFenced(f.folder)).toBe(true); expect(memoryFolderPrompt(f.folder).ok).toBe(false);
    let committed = false;
    expect(recoverForget(f.folder, "wrong-custody-key", () => { committed = true; }).ok).toBe(false); expect(committed).toBe(false);
    expect(recoverForget(f.folder, key, (ids, mode) => f.store.forget(ids, mode)).ok).toBe(true);
    expect(memoryUseFenced(f.folder)).toBe(false); expect(f.store.authorizationItems([f.item.id])).toHaveLength(0);
    expect(existsSync(join(f.folder, "authority.md"))).toBe(false);
  } finally { f.close(); }
});
test("authority head refresh honors current revocation/expiry without using historical evidence", () => {
  const f = fixture(false);
  try {
    expect(memoryFolderPrompt(f.folder).ok).toBe(true);
    const path = join(f.folder, "authority.md"), text = readFileSync(path, "utf8");
    writeFileSync(path, text.replace('"active"', '"revoked"'));
    const revoked = memoryFolderPrompt(f.folder); if (!revoked.ok) throw new Error(revoked.error.message);
    expect(revoked.value).toContain("revoked"); expect(revoked.value).not.toContain("Explicit fixture authority");
    writeFileSync(path, text.replace('"validUntil": null', '"validUntil": "2026-01-01T00:00:00Z"'));
    const expired = memoryFolderPrompt(f.folder, Date.parse("2026-10-10T00:00:00Z")); if (!expired.ok) throw new Error(expired.error.message);
    expect(expired.value).toContain("expired"); expect(expired.value).not.toContain("Explicit fixture authority");
  } finally { f.close(); }
});
