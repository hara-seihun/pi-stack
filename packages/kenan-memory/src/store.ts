import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Disclosure, DisclosureInput, ForgetMode, MemoryInput, MemoryItem, MemoryRead, ReadContext } from "./contract.js";

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
      CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, person TEXT NOT NULL, thread TEXT NOT NULL);
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
  search(person: string, context: ReadContext, query: string, about?: string[], limit = 20): MemoryRead<MemoryItem[]> {
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
    parameters.push(Math.min(100, Math.max(1, limit)));
    const join = terms.length ? "JOIN memory_search ON memory_search.id=memories.id" : "";
    const ranking = terms.length ? "bm25(memory_search)," : "";
    const rows = this.db.query(`SELECT body FROM memories ${join} WHERE stopped=0 ${clauses.length ? `AND ${clauses.join(" AND ")}` : ""} ORDER BY ${ranking} json_extract(body,'$.recordedAt') DESC,memories.id DESC LIMIT ?`).all(...parameters) as { body: string }[];
    return this.report(person, context, rows.map(row => JSON.parse(row.body)));
  }
  read(person: string, context: ReadContext, ids: string[]): MemoryRead<MemoryItem[]> {
    const query = this.db.query("SELECT body FROM memories WHERE id=? AND stopped=0");
    const items = ids.flatMap(id => { const row = query.get(id) as { body: string } | null; return row ? [JSON.parse(row.body)] : []; });
    return this.report(person, context, items);
  }
  forget(ids: string[], mode: ForgetMode): { forgotten: string[]; mode: ForgetMode } {
    const result = this.db.transaction(() => {
      const forgotten: string[] = [];
      for (const id of ids) {
        const row = this.db.query("SELECT body FROM memories WHERE id=?").get(id) as { body: string } | null;
        if (!row) continue;
        if (mode === "delete") this.db.query("DELETE FROM memories WHERE id=?").run(id);
        else this.db.query("UPDATE memories SET stopped=1,body=? WHERE id=?").run(JSON.stringify({ ...JSON.parse(row.body), stoppedAt: new Date().toISOString() }), id);
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
  disclosures(person: string, context: ReadContext, limit = 50): MemoryRead<Disclosure[]> {
    const rows = this.db.query(`SELECT body FROM disclosures WHERE EXISTS(SELECT 1 FROM json_each(json_extract(disclosures.body,'$.about')) WHERE value=?) ORDER BY json_extract(body,'$.occurredAt') DESC,id DESC LIMIT ?`).all(person, Math.min(100, Math.max(1, limit))) as { body: string }[];
    return this.report(person, context, rows.map(row => JSON.parse(row.body)));
  }
  session(person: string, threadId: string): { person: string; threadId: string; token: string } {
    const token = randomUUID() + randomUUID();
    this.db.query("INSERT INTO sessions(token,person,thread) VALUES(?,?,?)").run(token, person, threadId);
    return { person, threadId, token };
  }
  resolveSession(token: string): { person: string; threadId: string } | undefined {
    const row = this.db.query("SELECT person,thread FROM sessions WHERE token=?").get(token) as { person: string; thread: string } | null;
    return row ? { person: row.person, threadId: row.thread } : undefined;
  }
  finalize(person: string, context: ReadContext, reply: string): { finalized: string[] } {
    const id = this.readLogId(person, context);
    const row = this.db.query("SELECT body FROM disclosures WHERE id=?").get(id) as { body: string } | null;
    if (!row) return { finalized: [] };
    const disclosure = JSON.parse(row.body) as Disclosure;
    this.db.query("UPDATE disclosures SET body=? WHERE id=?").run(JSON.stringify({ ...disclosure, finalReply: reply, finalizedAt: new Date().toISOString() }), id);
    return { finalized: [id] };
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
