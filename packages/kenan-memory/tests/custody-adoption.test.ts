import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptMarkdown, type AdoptionOptions } from "../src/adoption.js";
import { authorityHead } from "../src/authority.js";
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "custody-adoption-")), path = join(directory, "source.sqlite3"), folder = join(directory, "policy");
  const subject = "shared-policy-subject", custodian = "registered-custodian", db = new Database(path), key = randomBytes(32), nonce = randomBytes(12);
  db.exec("CREATE TABLE life_keys(subject TEXT PRIMARY KEY,key BLOB); CREATE TABLE life_versions(subject TEXT,lane TEXT,record TEXT,revision INTEGER,payload TEXT); CREATE TABLE life_heads(subject TEXT,lane TEXT,record TEXT,revision INTEGER); CREATE TABLE memories(id TEXT,body TEXT,stopped INTEGER); CREATE TABLE disclosures(id TEXT,body TEXT)");
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(JSON.stringify([subject, "policy", "authority", 1])));
  const payload = Buffer.concat([cipher.update(JSON.stringify({ id: "authority", revision: 1, value: { status: "active", delegation: "Explicit fixture service policy", provenance: { factClass: "stated", validFrom: null, validUntil: null } } })), cipher.final()]);
  db.query("INSERT INTO life_keys VALUES(?,?)").run(subject, key);
  db.query("INSERT INTO life_versions VALUES(?,?,?,?,?)").run(subject, "policy", "authority", 1, Buffer.concat([nonce, cipher.getAuthTag(), payload]).toString("base64"));
  db.query("INSERT INTO life_heads VALUES(?,?,?,?)").run(subject, "policy", "authority", 1);
  db.query("INSERT INTO memories VALUES(?,?,?)").run("capture", "Private consultation journal must not even be parsed", 0);
  db.query("INSERT INTO disclosures VALUES(?,?)").run("disclosure", "Private disclosure journal must remain native");
  db.close();
  const options: AdoptionOptions = {
    source: { path, format: "memory", selection: { kind: "custody-subject", subject, custodian }, resource: { id: "source", kind: "data", owner: custodian, privacy: "confidential", subjects: [subject], consent: "not-required" } },
    destination: { path: folder, resource: { id: "folder", kind: "memory", owner: custodian, privacy: "confidential", subjects: [subject], consent: "not-required" } },
    principal: { kind: "service", id: "adopter" }, now: 1,
    policy: { revision: 1, consents: [], grants: ["source", "folder"].map(id => ({ id, principal: "adopter", resource: { kind: "exact", id }, actions: [id === "source" ? "read" : "write"], effect: "allow", validFrom: 0, validUntil: null, issuedBy: custodian, source: "Explicit fixture adoption grants" })) },
  };
  return { directory, subject, options };
}
test("a service policy subject is distinct from its custodian; only selected life versions/current head cross", () => {
  const f = fixture();
  try {
    const before = readFileSync(f.options.source.path);
    const result = adoptMarkdown(f.options);
    expect(result).toMatchObject({ ok: true, value: { records: 1, currentHead: { subject: f.subject, revision: 1 } } });
    const retry = adoptMarkdown(f.options);
    expect(retry).toMatchObject({ ok: true, value: { records: 1, created: 0 } });
    if (!result.ok || !retry.ok) throw new Error("Fixture adoption failed");
    expect(result.value.ownershipPaths).toContain(f.options.destination.path);
    expect(result.value.ownershipPaths).toContain(join(f.options.destination.path, "authority.md"));
    expect(retry.value.ownershipPaths).toEqual(result.value.ownershipPaths);
    expect(authorityHead(readFileSync(join(f.options.destination.path, "authority.md"), "utf8"))?.subject).toBe(f.subject);
    const records = readdirSync(join(f.options.destination.path, "records")).map(file => readFileSync(join(f.options.destination.path, "records", file), "utf8")).join("\n");
    expect(records).not.toContain("Private consultation"); expect(records).not.toContain("Private disclosure");
    expect(readFileSync(f.options.source.path).equals(before)).toBe(true);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});
test("custody-subject projection cannot reinterpret a person owner or weaken explicit grants/privacy", () => {
  const f = fixture(), { options, subject } = f;
  try {
    expect(adoptMarkdown({ ...options, source: { ...options.source, selection: { kind: "person", person: subject } } })).toMatchObject({ ok: false, error: { code: "invalid-options" } });
    expect(adoptMarkdown({ ...options, destination: { ...options.destination, resource: { ...options.destination.resource, owner: subject } } })).toMatchObject({ ok: false, error: { code: "invalid-options" } });
    expect(adoptMarkdown({ ...options, source: { ...options.source, resource: { ...options.source.resource, owner: "another-custodian" } } })).toMatchObject({ ok: false, error: { code: "invalid-options" } });
    expect(adoptMarkdown({ ...options, source: { ...options.source, resource: { ...options.source.resource, subjects: [] } } })).toMatchObject({ ok: false, error: { code: "invalid-options" } });
    expect(adoptMarkdown({ ...options, principal: { kind: "person", id: "adopter", person: subject } })).toMatchObject({ ok: false, error: { code: "invalid-options" } });
    expect(adoptMarkdown({ ...options, policy: { revision: 1, grants: [], consents: [] } })).toMatchObject({ ok: false, error: { code: "denied" } });
    expect(adoptMarkdown({ ...options, destination: { ...options.destination, resource: { ...options.destination.resource, privacy: "private" } } })).toMatchObject({ ok: false, error: { code: "denied" } });
    const protectedPlan: AdoptionOptions = { ...options, source: { ...options.source, resource: { ...options.source.resource, consent: "required" } }, destination: { ...options.destination, resource: { ...options.destination.resource, consent: "required" } } };
    expect(adoptMarkdown(protectedPlan)).toMatchObject({ ok: false, error: { code: "denied" } });
    const consents = ["source", "folder"].map(id => ({ id: `consent-${id}`, subject, principal: "adopter", resource: id, actions: [id === "source" ? "read" as const : "write" as const], validFrom: 0, validUntil: null, source: "Explicit fixture subject consent" }));
    expect(adoptMarkdown({ ...protectedPlan, policy: { ...options.policy, consents: consents.slice(0, 1) } })).toMatchObject({ ok: false, error: { code: "denied" } });
    expect(adoptMarkdown({ ...protectedPlan, policy: { ...options.policy, consents } }).ok).toBe(true);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});
