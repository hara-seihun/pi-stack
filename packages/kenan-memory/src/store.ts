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
    const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const patterns = terms.map(term => `%${term.replace(/[\\%_]/g, "\\$&")}%`);
    const clauses = patterns.map(() => "lower(json_extract(body,'$.text')) LIKE ? ESCAPE '\\'");
    if (about?.length) clauses.push(`EXISTS(SELECT 1 FROM json_each(json_extract(memories.body,'$.about')) WHERE value IN (${about.map(() => "?").join(",")}))`);
    const rows = this.db.query(`SELECT body FROM memories WHERE stopped=0 ${clauses.length ? `AND ${clauses.join(" AND ")}` : ""} ORDER BY json_extract(body,'$.recordedAt') DESC,id DESC LIMIT ?`).all(...patterns, ...(about ?? []), Math.min(100, Math.max(1, limit))) as { body: string }[];
    return this.report(person, context, rows.map(row => JSON.parse(row.body)));
  }
  read(person: string, context: ReadContext, ids: string[]): MemoryRead<MemoryItem[]> {
    const query = this.db.query("SELECT body FROM memories WHERE id=? AND stopped=0");
    const items = ids.flatMap(id => { const row = query.get(id) as { body: string } | null; return row ? [JSON.parse(row.body)] : []; });
    return this.report(person, context, items);
  }
  forget(ids: string[], mode: ForgetMode): { forgotten: string[]; mode: ForgetMode } {
    return this.db.transaction(() => {
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
  private report<T extends { about: string[] }>(person: string, context: ReadContext, items: T[]): MemoryRead<T[]> {
    const about = [...new Set(items.flatMap(item => item.about))];
    return { value: items, readReport: { ...context, person, about, touchedOtherPeople: !!context.roomId || about.some(subject => subject !== person) } };
  }
}
