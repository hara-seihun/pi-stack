import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptMarkdown, type AdoptionOptions } from "../src/adoption.js";
import { memoryFolderPrompt } from "../src/markdown.js";
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "memory-adoption-"));
  const source = join(directory, "source.sqlite3");
  const folder = join(directory, "memory");
  const db = new Database(source);
  db.exec("CREATE TABLE life_keys(subject TEXT PRIMARY KEY,key BLOB); CREATE TABLE life_versions(subject TEXT,lane TEXT,record TEXT,revision INTEGER,payload TEXT); CREATE TABLE life_heads(subject TEXT,lane TEXT,record TEXT,revision INTEGER); CREATE TABLE memories(id TEXT,body TEXT,stopped INTEGER); CREATE TABLE disclosures(id TEXT,body TEXT)");
  const key = randomBytes(32);
  db.query("INSERT INTO life_keys VALUES(?,?)").run("alice", key);
  for (const [lane, value] of [["policy", { status: "revoked", exclusions: ["private-source"], provenance: { validUntil: "2026-01-01" } }], ["steering", { state: "uncertain", policyRevision: 1, visibility: "silent", receipt: null }]] as const) {
    const record = `opaque-${lane}`;
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from(JSON.stringify(["alice", lane, record, 1])));
    const body = Buffer.concat([cipher.update(JSON.stringify({ id: lane, revision: 1, recordedBy: "alice", value })), cipher.final()]);
    db.query("INSERT INTO life_versions VALUES(?,?,?,?,?)").run("alice", lane, record, 1, Buffer.concat([nonce, cipher.getAuthTag(), body]).toString("base64"));
    db.query("INSERT INTO life_heads VALUES(?,?,?,?)").run("alice", lane, record, 1);
  }
  db.query("INSERT INTO memories VALUES(?,?,?)").run("stopped", JSON.stringify({ about: ["alice"], text: "stopped exact text" }), 1);
  db.query("INSERT INTO memories VALUES(?,?,?)").run("shared", JSON.stringify({ about: ["alice", "bob"], text: "other-person private text" }), 0);
  db.query("INSERT INTO disclosures VALUES(?,?)").run("consent", JSON.stringify({ about: ["alice"], kind: "consent-answer", text: "No" }));
  db.close();
  const options: AdoptionOptions = {
    source: { resource: { id: "source", kind: "data", owner: "custody", privacy: "confidential", subjects: ["alice"], consent: "not-required" }, path: source, selection: { kind: "person", person: "alice" }, format: "memory" },
    destination: { resource: { id: "folder", kind: "memory", owner: "alice", privacy: "confidential", subjects: ["alice"], consent: "not-required" }, path: folder },
    principal: { kind: "service", id: "adopter" }, now: 2,
    policy: { revision: 1, consents: [], grants: ["source", "folder"].map(id => ({ id, principal: "adopter", resource: { kind: "exact", id }, actions: [id === "source" ? "read" : "write"], effect: "allow", validFrom: 1, validUntil: null, issuedBy: "alice", source: "adoption decision" })) },
  };
  return { directory, options };
}
test("adoption is exact, idempotent, non-destructive, and excludes another person's material", () => {
  const { directory, options } = fixture();
  try {
    const before = readFileSync(options.source.path);
    const first = adoptMarkdown(options);
    expect(first).toMatchObject({ ok: true, value: { records: 4, created: 4 } });
    expect(adoptMarkdown(options)).toMatchObject({ ok: true, value: { records: 4, created: 0 } });
    expect(readFileSync(options.source.path).equals(before)).toBe(true);
    const contents = readdirSync(join(options.destination.path, "records")).map(name => readFileSync(join(options.destination.path, "records", name), "utf8")).join("\n");
    expect(contents).toContain('"status": "revoked"');
    expect(contents).toContain('"state": "uncertain"');
    expect(contents).toContain("stopped exact text");
    expect(contents).toContain("consent-answer");
    expect(contents).not.toContain("other-person private text");
    expect(memoryFolderPrompt(options.destination.path).ok).toBe(true);
    writeFileSync(join(options.destination.path, "work.md"), "Human corrected this note\n");
    expect(adoptMarkdown(options).ok).toBe(true);
    expect(readFileSync(join(options.destination.path, "work.md"), "utf8")).toBe("Human corrected this note\n");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test("no grants or weaker custody cannot export", () => {
  const { directory, options } = fixture();
  try {
    expect(adoptMarkdown({ ...options, policy: { revision: 1, grants: [], consents: [] } })).toMatchObject({ ok: false, error: { code: "denied" } });
    expect(adoptMarkdown({ ...options, destination: { ...options.destination, resource: { ...options.destination.resource, privacy: "public" } } })).toMatchObject({ ok: false, error: { code: "denied" } });
    expect(memoryFolderPrompt(undefined)).toMatchObject({ ok: false, error: { code: "unset" } });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
