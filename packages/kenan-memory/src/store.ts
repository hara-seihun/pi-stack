import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Disclosure, DisclosureInput, ForgetMode, MemoryInput, MemoryItem, MemoryRead, ReadContext, MemoryRole, MemoryResult, MemorySession, RootAdmission, RootFinalizeReply, RootResumeConsent, RootLogConsent, RootLogNotification, RootLogRequestStatus } from "./contract.js";

import { kenanRequestNotice } from "./contract.js";
import { isMemoryRole, memoryRoles, stateValue } from "./explicit-state.js";
const forgetModes = { delete: "delete", "stop-using": "stop-using" } satisfies Record<ForgetMode, ForgetMode>;
const consentKinds = {
  question: { kind: "consent-question", recipient: "subject" },
  answer: { kind: "consent-answer", recipient: "kenan" },
} as const satisfies Record<RootLogConsent["kind"], { kind: Disclosure["kind"]; recipient: "subject" | "kenan" }>;

export class MemoryStore {
  readonly db: Database;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true, strict: true });
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY, body TEXT NOT NULL, stopped INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS dedup(key TEXT PRIMARY KEY, id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS disclosures(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, person TEXT NOT NULL, thread TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'person');
      CREATE TABLE IF NOT EXISTS root_runs(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS consent_resumes(id TEXT PRIMARY KEY, input TEXT NOT NULL, admission TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS root_continuations(original TEXT PRIMARY KEY, resumed TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_search USING fts5(id UNINDEXED, text, tokenize='porter unicode61');
      INSERT INTO memory_search(memory_search,rank) VALUES('secure-delete',1);
      CREATE TRIGGER IF NOT EXISTS memory_search_insert AFTER INSERT ON memories WHEN new.stopped=0 BEGIN
        INSERT INTO memory_search(id,text) VALUES(new.id,json_extract(new.body,'$.text'));
      END;
      CREATE TRIGGER IF NOT EXISTS memory_search_delete AFTER DELETE ON memories BEGIN
        DELETE FROM memory_search WHERE id=old.id;
      END;
      CREATE TRIGGER IF NOT EXISTS memory_search_update AFTER UPDATE ON memories BEGIN
        DELETE FROM memory_search WHERE id=old.id;
        INSERT INTO memory_search(id,text) SELECT new.id,json_extract(new.body,'$.text') WHERE new.stopped=0;
      END;
      INSERT INTO memory_search(id,text) SELECT id,json_extract(body,'$.text') FROM memories
        WHERE stopped=0 AND id NOT IN (SELECT id FROM memory_search);
    `);
    const columns = this.db.query("PRAGMA table_info(sessions)").all() as { name: string }[];
    if (!columns.some(column => column.name === "role")) this.db.exec("ALTER TABLE sessions ADD COLUMN role TEXT NOT NULL DEFAULT 'person'");
  }
  close() { this.db.close(); }
  write(person: string, input: MemoryInput): MemoryItem | { id: string; forgotten: true } {
    return this.db.transaction(() => {
      const key = input.source.externalId ? createHash("sha256").update(`${person}\0${input.source.externalId}`).digest("hex") : undefined;
      if (key) {
        const prior = this.db.query("SELECT id FROM dedup WHERE key=?").get(key) as { id: string } | null;
        if (prior) {
          const row = this.db.query("SELECT body,stopped FROM memories WHERE id=?").get(prior.id) as { body: string; stopped: number } | null;
          return row && !row.stopped ? JSON.parse(row.body) as MemoryItem : { id: prior.id, forgotten: true as const };
        }
      }
      const now = new Date().toISOString();
      const item: MemoryItem = { ...input, id: randomUUID(), occurredAt: input.occurredAt ?? now, recordedAt: now, recordedBy: person };
      this.db.query("INSERT INTO memories(id,body) VALUES(?,?)").run(item.id, JSON.stringify(item));
      if (key) this.db.query("INSERT INTO dedup(key,id) VALUES(?,?)").run(key, item.id);
      return item;
    })();
  }
  search(person: string, context: ReadContext, query: string, about?: string[], limit = 20, role: MemoryRole = "root", permit?: (item: MemoryItem) => boolean): MemoryRead<MemoryItem[]> {
    stateValue(memoryRoles, role);
    const terms = query.match(/[\p{L}\p{N}]+/gu) ?? [];
    if (query.trim() && !terms.length) return this.report(person, context, []);
    const clauses: string[] = [];
    const parameters: (string | number)[] = [];
    if (terms.length) {
      clauses.push("memory_search MATCH ?");
      parameters.push(terms.map(term => `\"${term}\"*`).join(" OR "));
    }
    if (about?.length) {
      clauses.push(`EXISTS(SELECT 1 FROM json_each(json_extract(memories.body,'$.about')) WHERE value IN (${about.map(() => "?").join(",")}))`);
      parameters.push(...about);
    }
    if (role === "person") {
      clauses.push(this.ownClause());
      parameters.push(person, person, person);
    }
    const maximum = Math.min(100, Math.max(1, limit));
    if (!permit) parameters.push(maximum);
    const join = terms.length ? "JOIN memory_search ON memory_search.id=memories.id" : "";
    const ranking = terms.length ? "bm25(memory_search)," : "";
    const rows = this.db.query(`SELECT body FROM memories ${join} WHERE stopped=0 ${clauses.length ? `AND ${clauses.join(" AND ")}` : ""} ORDER BY ${ranking} json_extract(body,'$.recordedAt') DESC,memories.id DESC${permit ? "" : " LIMIT ?"}`).all(...parameters) as { body: string }[];
    const items = rows.map(row => JSON.parse(row.body) as MemoryItem);
    return this.report(person, context, (permit ? items.filter(permit) : items).slice(0, maximum));
  }
  read(person: string, context: ReadContext, ids: string[], role: MemoryRole = "root", permit?: (item: MemoryItem) => boolean): MemoryRead<MemoryItem[]> {
    stateValue(memoryRoles, role);
    const query = this.db.query(`SELECT body FROM memories WHERE id=? AND stopped=0 ${role === "person" ? `AND ${this.ownClause()}` : ""}`);
    const items = ids.flatMap(id => { const row = query.get(id, ...(role === "person" ? [person, person, person] : [])) as { body: string } | null; return row ? [JSON.parse(row.body)] : []; });
    return this.report(person, context, permit ? items.filter(permit) : items);
  }
  authorizationItems(ids: string[]): MemoryItem[] {
    const query = this.db.query("SELECT body FROM memories WHERE id=?");
    return ids.flatMap(id => { const row = query.get(id) as { body: string } | null; return row ? [JSON.parse(row.body) as MemoryItem] : []; });
  }
  forget(ids: string[], mode: ForgetMode): { forgotten: string[]; mode: ForgetMode } {
    stateValue(forgetModes, mode);
    const result = this.db.transaction(() => {
      const forgotten: string[] = [];
      for (const id of ids) {
        const row = this.db.query("SELECT body FROM memories WHERE id=?").get(id) as { body: string } | null;
        if (!row) continue;
        if (mode === "delete") this.db.query("DELETE FROM memories WHERE id=?").run(id);
        else if (mode === "stop-using") this.db.query("UPDATE memories SET stopped=1,body=? WHERE id=?").run(JSON.stringify({ ...JSON.parse(row.body), stoppedAt: new Date().toISOString() }), id);
        forgotten.push(id);
      }
      return { forgotten, mode };
    })();
    if (mode === "delete") this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    return result;
  }
  disclose(person: string, input: DisclosureInput): Disclosure {
    const disclosure: Disclosure = { ...input, id: randomUUID(), occurredAt: input.occurredAt ?? new Date().toISOString(), recordedBy: person };
    this.db.query("INSERT INTO disclosures(id,body) VALUES(?,?)").run(disclosure.id, JSON.stringify(disclosure));
    return disclosure;
  }
  disclosures(person: string, context: ReadContext, limit = 50, role: MemoryRole = "root", subject = person, permit?: (item: Disclosure) => boolean): MemoryRead<Disclosure[]> {
    stateValue(memoryRoles, role);
    const own = role === "person" ? "AND NOT EXISTS(SELECT 1 FROM json_each(json_extract(disclosures.body,'$.about')) WHERE value<>?)" : "";
    const rows = this.db.query(`SELECT body FROM disclosures WHERE EXISTS(SELECT 1 FROM json_each(json_extract(disclosures.body,'$.about')) WHERE value=?) ${own} ORDER BY json_extract(body,'$.occurredAt') DESC,id DESC${permit ? "" : " LIMIT ?"}`).all(subject, ...(role === "person" ? [person] : []), ...(permit ? [] : [Math.min(100, Math.max(1, limit))])) as { body: string }[];
    const items = rows.map(row => JSON.parse(row.body) as Disclosure);
    return this.report(person, context, (permit ? items.filter(permit) : items).slice(0, Math.min(100, Math.max(1, limit))));
  }
  session(person: string, threadId: string, role: MemoryRole = "person"): MemorySession {
    stateValue(memoryRoles, role);
    const token = randomUUID() + randomUUID();
    this.db.query("INSERT INTO sessions(token,person,thread,role) VALUES(?,?,?,?)").run(token, person, threadId, role);
    return { person, threadId, token, role };
  }
  resolveSession(token: string): { person: string; threadId: string; role: MemoryRole } | undefined {
    const row = this.db.query("SELECT person,thread,role FROM sessions WHERE token=?").get(token) as { person: string; thread: string; role: MemoryRole } | null;
    if (!row || !isMemoryRole(row.role)) return undefined;
    return { person: row.person, threadId: row.thread, role: row.role };
  }
  canForget(person: string, ids: string[]): boolean {
    const query = this.db.query("SELECT id FROM memories WHERE id=? AND json_extract(body,'$.recordedBy')=? AND NOT EXISTS(SELECT 1 FROM json_each(json_extract(memories.body,'$.about')) WHERE value<>?)");
    return ids.every(id => !!query.get(id, person, person));
  }
  private ownClause(): string {
    return `((json_extract(memories.body,'$.recordedBy')=? AND NOT EXISTS(SELECT 1 FROM json_each(json_extract(memories.body,'$.about')) WHERE value<>?)) OR (json_extract(memories.body,'$.source.action') IS NOT NULL AND json_extract(memories.body,'$.obviouslyPrivate')=0 AND EXISTS(SELECT 1 FROM json_each(json_extract(memories.body,'$.about')) WHERE value=?)))`;
  }
  admitRoot(person: string, threadId: string, recipients: string[], subjects: string[], roomId?: string, rootSessionId = randomUUID()): RootAdmission {
    return this.db.transaction(() => {
      const memory = this.session(person, rootSessionId, "root");
      const admission: RootAdmission = { person, threadId, recipients, subjects, rootSessionId, memoryToken: memory.token, ...(roomId ? { roomId } : {}) };
      this.db.query("INSERT INTO root_runs(id,body) VALUES(?,?)").run(rootSessionId, JSON.stringify(admission));
      return admission;
    })();
  }
  rootAdmission(id: string): RootAdmission | undefined {
    const row = this.db.query("SELECT body FROM root_runs WHERE id=?").get(id) as { body: string } | null;
    return row ? JSON.parse(row.body) : undefined;
  }
  authorizationSubjects(rootSessionId: string): string[] {
    const admission = this.rootAdmission(rootSessionId);
    if (!admission) return [];
    const reads = this.db.query("SELECT body FROM disclosures WHERE json_extract(body,'$.kind')='memory-read' AND json_extract(body,'$.setting.threadId')=?").all(rootSessionId) as { body: string }[];
    return [...new Set([admission.person, ...admission.subjects, ...reads.flatMap(row => (JSON.parse(row.body) as Disclosure).about)])];
  }
  private consentKey(rootSessionId: string, consentId: string): string {
    return createHash("sha256").update(JSON.stringify([rootSessionId, consentId])).digest("hex");
  }
  logConsent(input: RootLogConsent): MemoryResult<Disclosure> {
    if (!Object.hasOwn(consentKinds, input.kind)) return { ok: false, error: "invalid-request", message: "Unknown consent kind" };
    const consent = stateValue(consentKinds, input.kind);
    return this.db.transaction((): MemoryResult<Disclosure> => {
      const admission = this.rootAdmission(input.rootSessionId);
      if (!admission) return { ok: false, error: "invalid-request", message: "Unknown original root session" };
      const key = this.consentKey(input.rootSessionId, input.consentId);
      const id = `consent-${input.kind}-${key}`;
      const prior = this.db.query("SELECT body FROM disclosures WHERE id=?").get(id) as { body: string } | null;
      if (prior) {
        const disclosure = JSON.parse(prior.body) as Disclosure;
        return disclosure.text === input.text && disclosure.consentSubject === input.subject
          ? { ok: true, value: disclosure }
          : { ok: false, error: "invalid-request", message: "Consent event was already logged with different content or subject" };
      }
      const question = this.db.query("SELECT body FROM disclosures WHERE id=?").get(`consent-question-${key}`) as { body: string } | null;
      if (input.kind === "answer" && (!question || !JSON.parse(question.body).to.includes(input.subject)))
        return { ok: false, error: "invalid-request", message: "Consent answers require a logged question to the same subject" };
      const now = new Date().toISOString();
      const disclosure: Disclosure = { id, rootSessionId: input.rootSessionId, consentId: input.consentId, consentSubject: input.subject,
        kind: consent.kind, text: input.text,
        about: [...new Set([...admission.subjects, admission.person, input.subject])],
        to: [consent.recipient === "subject" ? input.subject : consent.recipient],
        setting: { person: admission.person, threadId: admission.threadId, ...(admission.roomId ? { roomId: admission.roomId } : {}) },
        occurredAt: now, recordedBy: "kenan" };
      this.db.query("INSERT INTO disclosures(id,body) VALUES(?,?)").run(id, JSON.stringify(disclosure));
      return { ok: true, value: disclosure };
    })();
  }
  logRequestStatus(input: RootLogRequestStatus): MemoryResult<{ id: string }> {
    if (input.status !== "failed" && input.status !== "interrupted") return { ok: false, error: "invalid-request", message: "Unknown request status" };
    return this.db.transaction((): MemoryResult<{ id: string }> => {
      const admission = this.rootAdmission(input.rootSessionId);
      if (!admission) return { ok: false, error: "invalid-request", message: "Request status requires an admitted root session" };
      const id = `request-status-${this.consentKey(input.rootSessionId, input.requestId)}`;
      const text = kenanRequestNotice(input.requestId, input.status);
      const prior = this.db.query("SELECT body FROM disclosures WHERE id=?").get(id) as { body: string } | null;
      if (prior) return JSON.parse(prior.body).text === text ? { ok: true, value: { id } } : { ok: false, error: "invalid-request", message: "Request status was already recorded differently" };
      const disclosure: Disclosure = { id, rootSessionId: input.rootSessionId, kind: "root-request-status", text, about: [...new Set([...admission.subjects, admission.person])], to: admission.recipients,
        setting: { person: admission.person, threadId: admission.threadId, ...(admission.roomId ? { roomId: admission.roomId } : {}) }, occurredAt: new Date().toISOString(), recordedBy: "kenan" };
      this.db.query("INSERT INTO disclosures(id,body) VALUES(?,?)").run(id, JSON.stringify(disclosure));
      return { ok: true, value: { id } };
    })();
  }
  logNotification(input: RootLogNotification): MemoryResult<{ id: string }> {
    return this.db.transaction((): MemoryResult<{ id: string }> => {
      const admission = this.rootAdmission(input.rootSessionId);
      if (!admission) return { ok: false, error: "invalid-request", message: "Notification requires an admitted root session" };
      const id = `notification-${this.consentKey(input.rootSessionId, input.notificationId)}`;
      const prior = this.db.query("SELECT body FROM disclosures WHERE id=?").get(id) as { body: string } | null;
      const about = [...new Set([...admission.subjects, admission.person, input.recipient, ...input.subjects])].sort();
      if (prior) {
        const old = JSON.parse(prior.body) as Disclosure & { obviouslyPrivate: boolean };
        return old.text === input.text && old.to.length === 1 && old.to[0] === input.recipient && JSON.stringify(old.about) === JSON.stringify(about) && old.obviouslyPrivate === input.obviouslyPrivate
          ? { ok: true, value: { id } }
          : { ok: false, error: "invalid-request", message: "Notification ID already used with different content" };
      }
      const now = new Date().toISOString();
      const setting = { person: admission.person, threadId: admission.threadId, ...(admission.roomId ? { roomId: admission.roomId } : {}) };
      const disclosure: Disclosure & { obviouslyPrivate: boolean } = { id, rootSessionId: input.rootSessionId, kind: "root-notification", text: input.text, about, to: [input.recipient], setting, occurredAt: now, recordedBy: "kenan", obviouslyPrivate: input.obviouslyPrivate };
      this.db.query("INSERT INTO disclosures(id,body) VALUES(?,?)").run(id, JSON.stringify(disclosure));
      this.write(admission.person, { text: input.text, about, source: { actedFor: admission.person, action: "notification-queued", externalId: id }, setting, occurredAt: now, obviouslyPrivate: input.obviouslyPrivate });
      return { ok: true, value: { id } };
    })();
  }
  resumeConsent(input: RootResumeConsent): MemoryResult<RootAdmission> {
    return this.db.transaction((): MemoryResult<RootAdmission> => {
      const original = this.rootAdmission(input.rootSessionId);
      if (!original) return { ok: false, error: "invalid-request", message: "Consent resumption requires an authenticated original root admission" };
      const key = this.consentKey(input.rootSessionId, input.consentId);
      const serialized = JSON.stringify([input.rootSessionId, input.subject, input.question, input.answer, input.consentId]);
      const prior = this.db.query("SELECT input,admission FROM consent_resumes WHERE id=?").get(key) as { input: string; admission: string } | null;
      if (prior) return prior.input === serialized
        ? { ok: true, value: JSON.parse(prior.admission) }
        : { ok: false, error: "invalid-request", message: "This consent was already resumed with different data" };
      const questionRow = this.db.query("SELECT body FROM disclosures WHERE id=?").get(`consent-question-${key}`) as { body: string } | null;
      const answerRow = this.db.query("SELECT body FROM disclosures WHERE id=?").get(`consent-answer-${key}`) as { body: string } | null;
      const question = questionRow ? JSON.parse(questionRow.body) as Disclosure : undefined;
      const answer = answerRow ? JSON.parse(answerRow.body) as Disclosure : undefined;
      if (!question || !answer || question.text !== input.question || answer.text !== input.answer || !question.to.includes(input.subject))
        return { ok: false, error: "invalid-request", message: "Consent resumption requires matching exact question and answer records" };
      const admission = this.admitRoot(original.person, original.threadId, original.recipients,
        [...new Set([...original.subjects, ...question.about, ...answer.about, input.subject])], original.roomId);
      this.db.query("INSERT INTO consent_resumes(id,input,admission) VALUES(?,?,?)").run(key, serialized, JSON.stringify(admission));
      if (!this.db.query("SELECT id FROM disclosures WHERE id=?").get(`root-reply-${original.rootSessionId}`)) {
        this.db.query("INSERT OR IGNORE INTO root_continuations(original,resumed) VALUES(?,?)").run(original.rootSessionId, admission.rootSessionId);
        this.db.query("DELETE FROM sessions WHERE token=?").run(original.memoryToken);
      }
      return { ok: true, value: admission };
    })();
  }
  finalizeRootReply(input: RootFinalizeReply): MemoryResult<Disclosure> {
    return this.db.transaction((): MemoryResult<Disclosure> => {
      const admission = this.rootAdmission(input.rootSessionId);
      if (!admission) return { ok: false, error: "invalid-request", message: "Unknown root session" };
      if (input.recipients && [...input.recipients].sort().join("\0") !== [...admission.recipients].sort().join("\0"))
        return { ok: false, error: "unauthenticated", message: "Root reply audience differs from admission" };
      const id = `root-reply-${input.rootSessionId}`;
      const prior = this.db.query("SELECT body FROM disclosures WHERE id=?").get(id) as { body: string } | null;
      if (prior) {
        const old = JSON.parse(prior.body) as Disclosure;
        return old.text === input.reply ? { ok: true, value: old } : { ok: false, error: "invalid-request", message: "Root reply was already finalized with different text" };
      }
      if (this.db.query("SELECT original FROM root_continuations WHERE original=?").get(input.rootSessionId))
        return { ok: false, error: "invalid-request", message: "This unfinished root session was superseded by consent continuation" };
      const reads = this.db.query("SELECT body FROM disclosures WHERE json_extract(body,'$.kind')='memory-read' AND json_extract(body,'$.setting.threadId')=?").all(input.rootSessionId) as { body: string }[];
      const about = [...new Set([...admission.subjects, admission.person, ...input.subjects, ...reads.flatMap(row => (JSON.parse(row.body) as Disclosure).about)])];
      const now = new Date().toISOString();
      const disclosure: Disclosure = { id, rootSessionId: input.rootSessionId, kind: "root-reply", text: input.reply, finalReply: input.reply,
        about, to: admission.recipients, setting: { person: admission.person, threadId: admission.threadId, ...(admission.roomId ? { roomId: admission.roomId } : {}) },
        occurredAt: now, finalizedAt: now, recordedBy: "kenan" };
      this.db.query("INSERT INTO disclosures(id,body) VALUES(?,?)").run(id, JSON.stringify(disclosure));
      this.db.query("DELETE FROM sessions WHERE token=?").run(admission.memoryToken);
      return { ok: true, value: disclosure };
    })();
  }
  finalize(person: string, context: ReadContext, reply: string): { finalized: string[] } {
    const id = this.readLogId(person, context);
    const row = this.db.query("SELECT body FROM disclosures WHERE id=?").get(id) as { body: string } | null;
    if (!row) return { finalized: [] };
    const disclosure = JSON.parse(row.body) as Disclosure;
    this.db.query("UPDATE disclosures SET body=? WHERE id=?").run(JSON.stringify({ ...disclosure, finalReply: reply, finalizedAt: new Date().toISOString() }), id);
    return { finalized: [id] };
  }
  reportData<T>(person: string, context: ReadContext, dataset: string, about: readonly string[], value: T): MemoryRead<T> {
    const report = this.report(person, context, [{ id: `data:${dataset}`, about: [...about] }]);
    return { value, readReport: report.readReport };
  }
  private readLogId(person: string, context: ReadContext) {
    return `read-${createHash("sha256").update(`${person}\0${context.threadId}\0${context.turnId}`).digest("hex")}`;
  }
  private report<T extends { id: string; about: string[] }>(person: string, context: ReadContext, items: T[]): MemoryRead<T[]> {
    const about = [...new Set(items.flatMap(item => item.about))];
    const touchedOtherPeople = !!context.roomId || about.some(subject => subject !== person);
    if (items.length && touchedOtherPeople) {
      const id = this.readLogId(person, context);
      const prior = this.db.query("SELECT body FROM disclosures WHERE id=?").get(id) as { body: string } | null;
      const old = prior ? JSON.parse(prior.body) as Disclosure : undefined;
      const subjects = [...new Set([...(old?.about ?? []), ...about])];
      const memoryIds = [...new Set([...(old?.memoryIds ?? []), ...items.map(item => item.id)])];
      const disclosure: Disclosure = { ...old, id, kind: "memory-read", turnId: context.turnId,
        text: `Consulted ${memoryIds.join(", ")} about ${subjects.join(", ")} while speaking with ${person} in ${context.roomId ?? context.threadId}`,
        about: subjects, to: [person], memoryIds, recordedBy: person,
        setting: { person, threadId: context.threadId, ...(context.roomId ? { roomId: context.roomId } : {}) },
        occurredAt: old?.occurredAt ?? new Date().toISOString() };
      this.db.query("INSERT INTO disclosures(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body").run(id, JSON.stringify(disclosure));
    }
    return { value: items, readReport: { ...context, person, about, touchedOtherPeople } };
  }
}
