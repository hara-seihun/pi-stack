export const IMAGE_CUSTODY_TABLES = ["inline_images", "inline_image_versions", "inline_image_messages", "core_image_acceptance", "core_image_sources", "core_image_ingress_errors", "core_image_threads"] as const;
type SchemaDatabase = { exec(sql: string): unknown; prepare(sql: string): { get(...args: string[]): unknown; all(): unknown[] } };

export function adoptImageSchema(db: SchemaDatabase): void {
  const tables = [
    { name: "inline_images", columns: "session_id,image_id,value,attempt_dir", schema: "session_id TEXT NOT NULL REFERENCES core_image_threads(id) ON DELETE CASCADE,image_id TEXT NOT NULL,value TEXT NOT NULL,attempt_dir TEXT,PRIMARY KEY(session_id,image_id)" },
    { name: "inline_image_versions", columns: "session_id,version", schema: "session_id TEXT PRIMARY KEY REFERENCES core_image_threads(id) ON DELETE CASCADE,version INTEGER NOT NULL" },
    { name: "inline_image_messages", columns: "session_id,message_key", schema: "session_id TEXT NOT NULL REFERENCES core_image_threads(id) ON DELETE CASCADE,message_key TEXT NOT NULL,PRIMARY KEY(session_id,message_key)" },
    { name: "core_image_acceptance", columns: "thread_id,message_key,text_hash", schema: "thread_id TEXT NOT NULL REFERENCES core_image_threads(id) ON DELETE CASCADE,message_key TEXT NOT NULL,text_hash TEXT NOT NULL,PRIMARY KEY(thread_id,message_key)" },
  ];
  db.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
  try {
    db.exec("CREATE TABLE IF NOT EXISTS core_image_threads(id TEXT PRIMARY KEY)");
    for (const table of tables) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table.name)) { db.exec(`CREATE TABLE ${table.name}(${table.schema})`); continue; }
      const id = table.name === "core_image_acceptance" ? "thread_id" : "session_id";
      db.exec(`INSERT OR IGNORE INTO core_image_threads SELECT ${id} FROM ${table.name}`);
      const references = db.prepare(`PRAGMA foreign_key_list(${table.name})`).all() as { table: string }[];
      if (references.length === 1 && references[0]!.table === "core_image_threads") continue;
      db.exec(`CREATE TABLE image_adoption_${table.name}(${table.schema});
        INSERT INTO image_adoption_${table.name}(${table.columns}) SELECT ${table.columns} FROM ${table.name} ORDER BY rowid;
        DROP TABLE ${table.name}; ALTER TABLE image_adoption_${table.name} RENAME TO ${table.name}`);
    }
    for (const table of tables) if (db.prepare(`PRAGMA foreign_key_check(${table.name})`).all().length) throw new Error(`Image adoption violates ${table.name} custody`);
    db.exec("COMMIT");
  } catch (cause) { db.exec("ROLLBACK"); throw cause; }
  finally { db.exec("PRAGMA foreign_keys=ON"); }
}

/** Called only after the fresh account reservation has established prior owner:none. */
export function initializeFreshImageSchema(db: SchemaDatabase): void {
  adoptImageSchema(db);
  db.exec(`CREATE TABLE IF NOT EXISTS core_image_sources(thread_id TEXT PRIMARY KEY,source_path TEXT NOT NULL,revision TEXT NOT NULL,last_offset INTEGER NOT NULL,last_digest TEXT NOT NULL,watermark_json TEXT);
    CREATE TABLE IF NOT EXISTS core_image_ingress_errors(thread_id TEXT NOT NULL,message_key TEXT NOT NULL,error TEXT NOT NULL,PRIMARY KEY(thread_id,message_key));`);
}
