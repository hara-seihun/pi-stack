import { Database } from "bun:sqlite";
import { createDecipheriv, createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { authorize, type PermissionPolicy, type Principal, type Resource } from "pi-orchestrator/permissions";
import { forgottenIds, projectionNode, memoryUseFenced } from "./forget-projection.js";
import { authorityHead, renderAuthority, type AuthorityHead } from "./authority.js";
import { MEMORY_FOLDER_AGENTS, MEMORY_FOLDER_README } from "./markdown.js";

export type AdoptionSelection = { kind: "person"; person: string } | { kind: "custody-subject"; subject: string; custodian: string } | { kind: "whole-store" };
export type AdoptionSource = { resource: Resource; path: string; selection: AdoptionSelection; format: "memory" | "calendar" };
export type AuthorityReceipt = { source: string; subject: string; revision: number; sha256: string };
export type AdoptionOptions = { source: AdoptionSource; destination: { resource: Resource; path: string }; principal: Principal; policy: PermissionPolicy; now: number; expectedAuthority?: AuthorityReceipt };
export type AdoptionError = { code: "invalid-options" | "denied" | "source-unavailable" | "invalid-record" | "destination-conflict" | "write-failed"; message: string };
export type AdoptionResult = { ok: true; value: { fingerprint: string; records: number; created: number; receipt: string; currentHead: AuthorityReceipt | null; ownershipPaths: string[] } } | { ok: false; error: AdoptionError };
type RecordData = { lane: string; id: string; value: unknown; current: boolean | null };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const fail = (code: AdoptionError["code"], message: string): AdoptionResult => ({ ok: false, error: { code, message } });
const prose = (value: unknown) => typeof value === "string" && value.trim().length > 0;
function install(path: string, contents: string): "created" | "present" | "conflict" {
  if (existsSync(path)) return realpathSync(path) === path && statSync(path).isFile() && readFileSync(path, "utf8") === contents ? "present" : "conflict";
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, contents); fsyncSync(fd); } finally { closeSync(fd); }
    try { linkSync(temporary, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return realpathSync(path) === path && readFileSync(path, "utf8") === contents ? "present" : "conflict";
    }
    return "created";
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
function ownRecord(body: unknown, person: string): boolean {
  if (!body || typeof body !== "object") return false;
  const about = (body as { about?: unknown }).about;
  return Array.isArray(about) && about.length > 0 && about.every(subject => subject === person);
}
function records(db: Database, source: AdoptionSource): RecordData[] {
  const output: RecordData[] = [];
  const tables = new Set((db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(row => row.name));
  const selection = source.selection;
  const subject = selection.kind === "person" ? selection.person : selection.kind === "custody-subject" ? selection.subject : null;
  if (source.format === "calendar" && !tables.has("events") || source.format === "memory" && !tables.has("memories") && !tables.has("life_versions")) throw new Error("Source does not match its declared format");
  if (source.format === "calendar") {
    for (const table of ["events", "subscriptions", "settings", "delete_undo"]) {
      if (!tables.has(table)) continue;
      const rows = db.query(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
      for (const row of rows) {
        const id = row.id ?? row.key ?? row.token;
        if (!prose(id)) throw new Error("Calendar row identifier missing");
        output.push({ lane: `calendar-${table}`, id: String(id), value: row, current: null });
      }
    }
  } else {
    for (const table of selection.kind === "custody-subject" ? [] : ["memories", "disclosures"]) {
      if (!tables.has(table)) continue;
      for (const row of db.query(`SELECT * FROM ${table}`).all() as { id: string; body: string; stopped?: number }[]) {
        const body = JSON.parse(row.body);
        if (selection.kind === "person" && !ownRecord(body, selection.person)) continue;
        if (selection.kind === "person" && table === "memories" && tables.has("root_runs") && body.setting?.threadId && db.query("SELECT id FROM root_runs WHERE id=?").get(body.setting.threadId)) continue;
        output.push({ lane: table, id: row.id, value: row, current: row.stopped === undefined ? null : row.stopped === 0 });
      }
    }
    if (tables.has("life_versions")) {
      if (!tables.has("life_keys") || !tables.has("life_heads")) throw new Error("Life decryption custody missing");
      const versions = db.query(`SELECT v.*,h.revision AS head FROM life_versions v LEFT JOIN life_heads h USING(subject,lane,record) ${subject !== null ? "WHERE v.subject=?" : ""} ORDER BY v.subject,v.lane,v.record,v.revision`).all(...(subject !== null ? [subject] : [])) as { subject: string; lane: string; record: string; revision: number; payload: string; head: number | null }[];
      for (const row of versions) {
        const key = db.query("SELECT key FROM life_keys WHERE subject=?").get(row.subject) as { key: Uint8Array } | null;
        if (!key || key.key.length !== 32) throw new Error("Life key missing");
        const bytes = Buffer.from(row.payload, "base64");
        const cipher = createDecipheriv("aes-256-gcm", Buffer.from(key.key), bytes.subarray(0, 12));
        cipher.setAuthTag(bytes.subarray(12, 28));
        cipher.setAAD(Buffer.from(JSON.stringify([row.subject, row.lane, row.record, row.revision])));
        const value = JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString("utf8"));
        if (!value || typeof value !== "object" || !prose(value.id) || value.revision !== row.revision) throw new Error("Invalid life version");
        output.push({ lane: `life-${row.lane}`, id: JSON.stringify([row.subject, value.id, row.revision]), value: { subject: row.subject, ...value }, current: row.revision === row.head });
      }
    }
  }
  return output.sort((a, b) => a.lane.localeCompare(b.lane) || a.id.localeCompare(b.id));
}

export function adoptMarkdown(options: AdoptionOptions): AdoptionResult {
  const { source, destination, principal, policy, now } = options;
  if (!source || !destination || typeof source.path !== "string" || typeof destination.path !== "string" || !isAbsolute(source.path) || !isAbsolute(destination.path) || source.path === destination.path || !prose(source.resource?.id) || !prose(destination.resource?.id) || source.resource.kind !== "data" || destination.resource.kind !== "memory" || !["memory", "calendar"].includes(source.format) || !["person", "custody-subject", "whole-store"].includes(source.selection?.kind)) return fail("invalid-options", "Adoption requires explicit source, format, selection and destination resources");
  if (source.selection.kind === "person" && (!prose(source.selection.person) || source.selection.person !== destination.resource.owner)) return fail("invalid-options", "Person adoption belongs in that person's memory folder");
  if (source.selection.kind === "custody-subject" && (source.format !== "memory" || principal?.kind !== "service" || !prose(source.selection.subject) || !prose(source.selection.custodian) || source.resource.owner !== source.selection.custodian || destination.resource.owner !== source.selection.custodian || !Array.isArray(source.resource.subjects) || !source.resource.subjects.includes(source.selection.subject) || !Array.isArray(destination.resource.subjects) || destination.resource.subjects.length !== 1 || destination.resource.subjects[0] !== source.selection.subject)) return fail("invalid-options", "Custody-subject adoption binds one explicit policy subject to its existing source/destination custodian, not a person owner");
  if (source.format === "calendar" && source.selection.kind === "person" && source.resource.owner !== source.selection.person) return fail("invalid-options", "Calendar adoption requires the person's owned source");
  const read = authorize(policy, { principal, resource: source.resource, action: "read", now });
  const write = authorize(policy, { principal, resource: destination.resource, action: "write", now });
  if (!read.ok || !write.ok) return fail("denied", "Adoption requires grants and consent for source read and destination write");
  if (source.resource.privacy !== "public" && destination.resource.privacy === "public" || source.resource.privacy === "confidential" && destination.resource.privacy !== "confidential" || source.selection.kind === "whole-store" && source.resource.owner !== destination.resource.owner) return fail("denied", "Adoption cannot broaden private custody");
  let db: Database;
  try { db = new Database(source.path, { readonly: true, strict: true }); } catch { return fail("source-unavailable", "Source database cannot be opened read-only"); }
  let data: RecordData[];
  try { data = db.transaction(() => records(db, source))(); } catch { return fail("invalid-record", "Source records or decryption custody are invalid; nothing is discarded"); } finally { db.close(); }
  const serialized = JSON.stringify({ source: { id: source.resource.id, format: source.format, selection: source.selection }, records: data });
  let fingerprint = hash(serialized);
  let created = 0;
  const ownershipPaths = new Set<string>();
  try {
    const firstDirectory = mkdirSync(destination.path, { recursive: true, mode: 0o700 });
    if (firstDirectory !== undefined) {
      let directory = firstDirectory;
      ownershipPaths.add(directory);
      for (const segment of destination.path.slice(firstDirectory.length).split("/").filter(Boolean)) { directory = join(directory, segment); ownershipPaths.add(directory); }
    }
    const folder = realpathSync(destination.path);
    if (folder !== destination.path) return fail("invalid-options", "Destination must be canonical and not a symlink");
    if (memoryUseFenced(folder)) return fail("destination-conflict", "Pending forget projection fences adoption until custody recovery");
    const invalid = new Set(forgottenIds(folder));
    let changed = true;
    while (changed) {
      changed = false;
      for (const record of data) {
        const node = projectionNode(record.value);
        if (node?.derived && node.dependencies.some(id => invalid.has(id)) && !invalid.has(node.id)) { invalid.add(node.id); changed = true; }
      }
    }
    data = data.filter(record => { const node = projectionNode(record.value); return !node || !invalid.has(node.id); });
    if (invalid.size) fingerprint = hash(JSON.stringify({ source: { id: source.resource.id, format: source.format, selection: source.selection }, exclusions: [...invalid].sort(), records: data }));
    const heads = source.selection.kind !== "whole-store" ? data.filter(record => record.lane === "life-policy" && record.current === true) : [];
    if (heads.length > 1) return fail("invalid-record", "A subject has conflicting current authority heads");
    const current = heads[0]?.value as { subject: string; revision: number; value: Record<string, unknown> } | undefined;
    const head: AuthorityHead | undefined = current ? { format: "markdown-authority-v1", subject: current.subject, revision: current.revision, source: source.resource.id, policy: current.value } : undefined;
    const authorityPath = join(folder, "authority.md");
    if (!head && source.selection.kind !== "whole-store" && existsSync(authorityPath)) return fail("destination-conflict", "Source has no current authority; an existing owning head cannot be blessed");
    let replaceAuthority: string | undefined;
    const currentHead: AuthorityReceipt | null = head ? { source: head.source, subject: head.subject, revision: head.revision, sha256: hash(renderAuthority(head)) } : null;
    if (head && existsSync(authorityPath)) {
      const before = readFileSync(authorityPath, "utf8"), existing = authorityHead(before);
      if (!existing || JSON.stringify(existing) !== JSON.stringify(head)) {
        const expected = options.expectedAuthority;
        if (!existing || !expected || existing.source !== head.source || existing.subject !== head.subject || expected.source !== existing.source || expected.subject !== existing.subject || expected.revision !== existing.revision || expected.sha256 !== hash(before) || before !== renderAuthority(existing) || existing.revision >= head.revision) return fail("destination-conflict", "Existing authority note conflicts with the selected head or expected adopted provenance");
        replaceAuthority = before;
      }
    } else if (options.expectedAuthority) return fail("destination-conflict", "Expected adopted authority is absent");
    ownershipPaths.add(folder);
    const recordFolder = join(folder, "records");
    mkdirSync(recordFolder, { recursive: true, mode: 0o700 });
    ownershipPaths.add(recordFolder);
    if (realpathSync(recordFolder) !== recordFolder) return fail("invalid-options", "Record directory must stay in the memory folder");
    const links: string[] = [];
    const notes = new Map<string, string[]>([["authority", []], ["work", []], ["calendar", []], ["steering", []]]);
    for (const record of data) {
      const filename = `${hash(JSON.stringify([source.resource.id, record.lane, record.id, record.value, record.current]))}.md`;
      const body = `# ${record.lane}\n\nSource: ${JSON.stringify(source.resource.id)}\n\nRecord identity: ${JSON.stringify(record.id)}\n\nCurrent at adoption: ${JSON.stringify(record.current)}\n\n\`\`\`json\n${JSON.stringify(record.value, null, 2)}\n\`\`\`\n`;
      const result = install(join(recordFolder, filename), body);
      if (result === "conflict") return fail("destination-conflict", "An adopted record has different content; source and prior notes remain intact");
      if (result === "created") created++;
      ownershipPaths.add(join(recordFolder, filename));
      const link = `- [${record.lane} ${hash(record.id).slice(0, 12)}](records/${filename}) — current at adoption: ${JSON.stringify(record.current)}`;
      links.push(link);
      const note = record.lane === "life-policy" ? "authority" : record.lane === "life-steering" ? "steering" : record.lane.startsWith("calendar-") ? "calendar" : "work";
      if (source.selection.kind !== "whole-store" && note !== "authority" && record.current !== false) notes.get(note)!.push(link);
    }
    if (head && replaceAuthority !== undefined) {
      const temporary = `${authorityPath}.${randomUUID()}.tmp`, fd = openSync(temporary, "wx", 0o600);
      try { writeFileSync(fd, renderAuthority(head)); fsyncSync(fd); } finally { closeSync(fd); }
      try {
        if (readFileSync(authorityPath, "utf8") !== replaceAuthority) return fail("destination-conflict", "Authority changed before adopted-head compare-and-swap");
        renameSync(temporary, authorityPath);
        ownershipPaths.add(authorityPath);
      } finally { if (existsSync(temporary)) unlinkSync(temporary); }
    } else if (head) {
      const result = install(authorityPath, renderAuthority(head));
      if (result === "conflict") return fail("destination-conflict", "Current authority note changed during adoption");
    }
    if (head) ownershipPaths.add(authorityPath);
    for (const [name, entries] of notes) {
      if (!entries.length) continue;
      const target = join(folder, `${name}.md`);
      const generated = `# ${name}\n\n${name === "calendar" ? `Structured memory dataset: ${JSON.stringify(source.resource.id)}. Use memory_data with this configured dataset ID; snapshot and saved-source refresh require explicit from/to instants. Updates/deletes select series or occurrence explicitly. Original settings/ICS/undo remain in adopted custody.\n\n` : ""}Adopted exact source records. Maintain the current facts and decisions in this note; preserve originals as provenance. Superseded, retracted, stopped or expired records supply no active work or authority.\n\n${entries.join("\n")}\n`;
      if (!existsSync(target)) {
        const result = install(target, generated);
        if (result === "conflict") return fail("destination-conflict", "An owning note changed during adoption");
        ownershipPaths.add(target);
      } else if (realpathSync(target) === target && statSync(target).isFile() && readFileSync(target, "utf8") === generated) ownershipPaths.add(target);
    }
    const recordFd = openSync(recordFolder, "r");
    try { fsyncSync(recordFd); } finally { closeSync(recordFd); }
    for (const [name, content] of [["README.md", MEMORY_FOLDER_README], ["AGENTS.md", MEMORY_FOLDER_AGENTS], ["records/README.md", "# Adopted records\n\nThe source manifest notes in the parent folder link exact original versions. Keep stopped, retracted and superseded records as evidence, not active work. Never discard the original effect/consent/disclosure stores on the strength of this export.\n"]] as const) {
      const target = join(folder, name);
      if (!existsSync(target)) {
        const result = install(target, content);
        if (result === "conflict") return fail("destination-conflict", "Memory pointers changed during adoption");
        ownershipPaths.add(target);
      } else if (realpathSync(target) === target && statSync(target).isFile() && readFileSync(target, "utf8") === content) ownershipPaths.add(target);
    }
    const receipt = `adoption-${fingerprint}.md`;
    const manifest = `# Adopted source\n\nSource identity: ${JSON.stringify(source.resource.id)}\n\nFingerprint: ${fingerprint}\n\nSelection: ${JSON.stringify(source.selection)}\n\n${links.join("\n")}\n\nPolicy and steering versions are evidence of stated authority and actions. Respect their validity, revocations, exclusions and actual scope. A record is not a new grant, renewed consent or permission to replay an uncertain effect. Shared and mixed-subject records not selected by a person export remain in their original restricted journal. Source databases and their effect, disclosure, consent and credential custody are not modified by adoption.\n`;
    const installedReceipt = install(join(folder, receipt), manifest);
    if (installedReceipt === "conflict") return fail("destination-conflict", "Adoption receipt differs");
    ownershipPaths.add(join(folder, receipt));
    const fd = openSync(folder, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    return { ok: true, value: { fingerprint, records: data.length, created, receipt, currentHead, ownershipPaths: [...ownershipPaths].sort() } };
  } catch { return fail("write-failed", "Adoption could not finish; source is untouched and retry reuses existing exact records"); }
}
