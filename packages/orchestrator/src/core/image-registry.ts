import type { Database } from "bun:sqlite";
import { mkdir, open, readFile, rename, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { createHash } from "node:crypto";
import { parseInlineImageTags, type InlineImage, type InlineImageErrorCode, type InlineImageSnapshot } from "./inline-image-contract.js";

export type InlineImageGenerationResult = { ok: true; images: Array<{ id: string; bytes: Buffer }>; model: string; responseId: string; usage: unknown }
  | { ok: false; error: { message: string } };
export type InlineImageGenerator = (request: { prompt: string; inputPaths: string[] }, signal: AbortSignal) => Promise<InlineImageGenerationResult>;
type Row = { session_id: string; image_id: string; value: string; attempt_dir: string | null };
const time = () => new Date().toISOString();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const problem = (code: InlineImageErrorCode, message: string) => ({ code, message });

async function durableFile(path: string, bytes: string | Buffer) {
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}
async function syncDirectory(path: string) {
  const file = await open(path, "r");
  try { await file.sync(); } finally { await file.close(); }
}

export function adoptImageSchema(db: Database) {
  const tables = [
    { name: "inline_images", columns: "session_id,image_id,value,attempt_dir", schema: "session_id TEXT NOT NULL REFERENCES core_image_threads(id) ON DELETE CASCADE,image_id TEXT NOT NULL,value TEXT NOT NULL,attempt_dir TEXT,PRIMARY KEY(session_id,image_id)" },
    { name: "inline_image_versions", columns: "session_id,version", schema: "session_id TEXT PRIMARY KEY REFERENCES core_image_threads(id) ON DELETE CASCADE,version INTEGER NOT NULL" },
    { name: "inline_image_messages", columns: "session_id,message_key", schema: "session_id TEXT NOT NULL REFERENCES core_image_threads(id) ON DELETE CASCADE,message_key TEXT NOT NULL,PRIMARY KEY(session_id,message_key)" },
    { name: "core_image_acceptance", columns: "thread_id,message_key,text_hash", schema: "thread_id TEXT NOT NULL REFERENCES core_image_threads(id) ON DELETE CASCADE,message_key TEXT NOT NULL,text_hash TEXT NOT NULL,PRIMARY KEY(thread_id,message_key)" },
  ];
  db.exec("PRAGMA foreign_keys=OFF");
  try {
    db.transaction(() => {
      db.exec("CREATE TABLE IF NOT EXISTS core_image_threads(id TEXT PRIMARY KEY)");
      for (const table of tables) {
        const exists = db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table.name);
        if (!exists) { db.exec(`CREATE TABLE ${table.name}(${table.schema})`); continue; }
        const id = table.name === "core_image_acceptance" ? "thread_id" : "session_id";
        db.exec(`INSERT OR IGNORE INTO core_image_threads SELECT ${id} FROM ${table.name}`);
        const references = db.query(`PRAGMA foreign_key_list(${table.name})`).all() as { table: string }[];
        if (references.length === 1 && references[0]!.table === "core_image_threads") continue;
        db.exec(`CREATE TABLE image_adoption_${table.name}(${table.schema});
          INSERT INTO image_adoption_${table.name}(${table.columns}) SELECT ${table.columns} FROM ${table.name} ORDER BY rowid;
          DROP TABLE ${table.name}; ALTER TABLE image_adoption_${table.name} RENAME TO ${table.name}`);
      }
      for (const table of tables) {
        if (db.query(`PRAGMA foreign_key_check(${table.name})`).all().length) throw new Error(`Image adoption violates ${table.name} custody`);
      }
    })();
  } finally { db.exec("PRAGMA foreign_keys=ON"); }
}

export class InlineImages {
  private active = new Map<string, { controller: AbortController; task: Promise<void> }>();
  private stopped = true;
  private pumping = false;
  private scheduled = false;
  constructor(private db: Database, private root: string, private generate: InlineImageGenerator,
    private changed: () => void, private concurrency = 2, private isOwner: () => boolean = () => true,
    private acceptsThread: (sessionId: string) => boolean = () => true,
    private resolvePath: (path: string) => string = path => path,
    private acceptsPath: (path: string) => boolean = () => true) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error("Image concurrency must be an integer from 1 to 8");
    adoptImageSchema(db);
  }

  version(sessionId: string): number {
    const row = this.db.query("SELECT version FROM inline_image_versions WHERE session_id=?").get(sessionId) as { version: number } | null;
    return row?.version ?? 0;
  }
  snapshot(sessionId: string): InlineImageSnapshot {
    return { version: this.version(sessionId), images: this.rows(sessionId).map(row => JSON.parse(row.value)) };
  }

  /** Definitions enter durable custody before scheduling or notifying the client. */
  accept(sessionId: string, messageKey: string, text: string) {
    if (!this.acceptsThread(sessionId) || !text.includes("<pi-remote-image")) return;
    const accepted = this.db.transaction(() => {
      if (!this.db.query("SELECT 1 FROM core_image_threads WHERE id=?").get(sessionId)) return false;
      if (this.db.query("SELECT 1 FROM inline_image_messages WHERE session_id=? AND message_key=?").get(sessionId, messageKey)) return false;
      this.db.query("INSERT INTO inline_image_messages VALUES(?,?)").run(sessionId, messageKey);
      for (const tag of parseInlineImageTags(text)) {
        if (!tag.definition || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(tag.id)) continue;
        const existing = this.get(sessionId, tag.id);
        if (existing) {
          if (JSON.stringify({ id: existing.id, prompt: existing.prompt, refs: existing.refs, ...(existing.prompt === null ? { sourcePath: existing.sourcePath } : {}) }) !== JSON.stringify(tag.definition) || tag.error) {
            if (!existing.conflict) this.save(sessionId, { ...existing, conflict: `Image ID ${tag.id} was redefined. Its first definition is immutable; use a new ID.` });
          }
          continue;
        }
        const now = time();
        this.save(sessionId, { ...tag.definition, state: tag.error ? "error" : "queued", createdAt: now, updatedAt: now,
          waitingFor: [], error: tag.error ? problem("invalid_definition", tag.error) : null, conflict: null,
          path: null, paths: [], model: null, responseId: null });
      }
      this.resolveDependencies(sessionId);
      return true;
    })();
    if (accepted) this.schedule();
  }

  async start() {
    await mkdir(this.resolvePath(this.root), { recursive: true, mode: 0o700 });
    for (const row of this.rows()) {
      const image = JSON.parse(row.value) as InlineImage;
      if (image.state !== "generating") continue;
      const receipt = row.attempt_dir ? await this.recover(row.attempt_dir) : null;
      if (receipt) this.save(row.session_id, { ...image, ...receipt, state: "complete", error: null });
      else this.fail(row.session_id, image, "interrupted", "The image owner stopped after claiming this request. Provider completion is unknown. No retry was made; use a new image ID to generate again.");
    }
    this.stopped = false;
    this.changed();
    this.pump();
  }

  stop() {
    this.stopped = true;
    for (const { controller } of this.active.values()) controller.abort();
    // In-flight rows remain generating until the next owner reconciles their receipts.
  }

  async close(): Promise<void> {
    this.stop();
    await Promise.all([...this.active.values()].map(({ task }) => task));
  }

  private rows(sessionId?: string): Row[] {
    return (sessionId ? this.db.query("SELECT * FROM inline_images WHERE session_id=? ORDER BY rowid").all(sessionId)
      : this.db.query("SELECT * FROM inline_images ORDER BY rowid").all()) as Row[];
  }
  private get(sessionId: string, id: string): InlineImage | null {
    const row = this.db.query("SELECT value FROM inline_images WHERE session_id=? AND image_id=?").get(sessionId, id) as { value: string } | null;
    return row ? JSON.parse(row.value) : null;
  }
  private save(sessionId: string, image: InlineImage, attemptDir?: string): boolean {
    return this.db.transaction(() => {
      const result = this.db.query(`INSERT INTO inline_images(session_id,image_id,value,attempt_dir)
        SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM core_image_threads WHERE id=?)
        ON CONFLICT(session_id,image_id) DO UPDATE SET value=excluded.value,attempt_dir=COALESCE(excluded.attempt_dir,inline_images.attempt_dir)`)
        .run(sessionId, image.id, JSON.stringify({ ...image, updatedAt: time() }), attemptDir ?? null, sessionId);
      if (!result.changes) return false;
      this.db.query(`INSERT INTO inline_image_versions VALUES(?,1) ON CONFLICT(session_id) DO UPDATE SET version=version+1`).run(sessionId);
      return true;
    })();
  }
  private finish(sessionId: string, id: string, result: Partial<Pick<InlineImage, "state" | "waitingFor" | "error" | "path" | "paths" | "model" | "responseId">>) {
    if (this.stopped || !this.isOwner()) return;
    this.db.transaction(() => {
      const image = this.get(sessionId, id);
      if (image?.state === "generating") this.save(sessionId, { ...image, ...result });
    })();
  }
  private fail(sessionId: string, image: InlineImage, code: InlineImageErrorCode, message: string) {
    this.save(sessionId, { ...image, state: "error", waitingFor: [], error: problem(code, message) });
  }
  private resolveDependencies(sessionId: string) {
    const images = new Map(this.snapshot(sessionId).images.map(image => [image.id, image]));
    const acyclic = new Set<string>();
    const visit = (id: string, path: Set<string>): boolean => {
      if (path.has(id)) return true;
      if (acyclic.has(id)) return false;
      const image = images.get(id);
      if (!image || image.state !== "queued") return false;
      path.add(id);
      const cyclic = image.refs.filter(ref => !ref.startsWith("/")).some(ref => visit(ref, path));
      path.delete(id);
      if (!cyclic) acyclic.add(id);
      return cyclic;
    };
    for (const image of images.values()) {
      if (image.state !== "queued") continue;
      if (visit(image.id, new Set())) {
        this.fail(sessionId, image, "dependency_cycle", `Image ${image.id} depends on a cycle.`);
        image.state = "error";
      }
    }
    let progress = true;
    while (progress) {
      progress = false;
      for (const image of images.values()) {
        if (image.state !== "queued") continue;
        const dependencies = image.refs.filter(ref => !ref.startsWith("/"));
        const missing = dependencies.find(ref => !images.has(ref));
        const failed = dependencies.find(ref => images.get(ref)?.state === "error");
        if (missing || failed) {
          this.fail(sessionId, image, missing ? "missing_dependency" : "dependency_failed", missing
            ? `Image reference ${missing} is not defined in this thread or message.` : `Image dependency ${failed} failed.`);
          image.state = "error"; progress = true;
        } else {
          const waitingFor = dependencies.filter(ref => images.get(ref)?.state !== "complete");
          if (JSON.stringify(waitingFor) !== JSON.stringify(image.waitingFor)) {
            image.waitingFor = waitingFor;
            this.save(sessionId, image);
          }
        }
      }
    }
  }
  private schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; if (!this.stopped) this.pump(); });
  }
  private pump() {
    if (this.stopped || !this.isOwner() || this.pumping) return;
    this.pumping = true;
    try {
      const sessions = new Set(this.rows().map(row => row.session_id));
      for (const sessionId of sessions) this.resolveDependencies(sessionId);
      for (const row of this.rows()) {
        if (this.active.size >= this.concurrency) break;
        const image = JSON.parse(row.value) as InlineImage;
        if (image.state !== "queued" || image.waitingFor.length) continue;
        const controller = new AbortController();
        const key = `${row.session_id}:${image.id}`;
        const directory = join(this.root, hash(row.session_id), image.id);
        // A durable claim precedes even auth/input preparation. Uncertainty never resubmits.
        if (!this.save(row.session_id, { ...image, state: "generating" }, directory)) continue;
        const task = this.run(row.session_id, image, directory, controller.signal).finally(() => {
          this.active.delete(key);
          if (!this.stopped) { this.pump(); this.changed(); }
        });
        this.active.set(key, { controller, task });
      }
    } finally { this.pumping = false; }
    this.changed();
  }
  private async run(sessionId: string, image: InlineImage, directory: string, signal: AbortSignal) {
    let providerCompleted = false;
    try {
      const parent = join(this.root, hash(sessionId));
      await mkdir(this.resolvePath(parent), { recursive: true, mode: 0o700 });
      await syncDirectory(this.resolvePath(this.root));
      await mkdir(this.resolvePath(directory), { mode: 0o700 });
      await syncDirectory(this.resolvePath(parent));
      if (image.prompt === null) {
        const extension = extname(image.sourcePath).slice(1).toLowerCase();
        if (!["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "svg"].includes(extension)) throw new Error("Image path must name a supported image file");
        if (!this.acceptsPath(image.sourcePath)) throw new Error("Image source path is outside the granted scope");
        const info = await stat(this.resolvePath(image.sourcePath));
        if (!info.isFile() || info.size > 32 * 1024 * 1024) throw new Error("Image path must name a file of at most 32 MiB");
        const bytes = await readFile(this.resolvePath(image.sourcePath), { signal });
        if (bytes.length > 32 * 1024 * 1024) throw new Error("Image file exceeds 32 MiB");
        signal.throwIfAborted();
        if (!this.isOwner() || !this.get(sessionId, image.id)) return;
        const path = join(directory, `1.${extension}`);
        await durableFile(this.resolvePath(path), bytes);
        const receipt = { path, paths: [path], model: null, responseId: null };
        await this.publishReceipt(directory, receipt, [createHash("sha256").update(bytes).digest("hex")]);
        this.finish(sessionId, image.id, { ...receipt, state: "complete", error: null });
        return;
      }
      const sources = await Promise.all(image.refs.map(async ref => {
        const path = ref.startsWith("/") ? ref : this.get(sessionId, ref)?.path;
        if (!path) throw new Error(`Missing completed image ${ref}`);
        if (!this.acceptsPath(path)) throw new Error("Image reference path is outside the granted scope");
        const info = await stat(this.resolvePath(path));
        if (!info.isFile()) throw new Error(`Invalid image reference: ${ref}`);
        return { path, size: info.size };
      }));
      if (sources.reduce((total, source) => total + source.size, 0) > 32 * 1024 * 1024) throw new Error("Image inputs exceed 32 MiB");
      const inputs: string[] = [];
      let totalBytes = 0;
      for (let i = 0; i < sources.length; i++) {
        // Snapshot external inputs once. The job owns their bytes even if the source is edited later.
        const target = join(directory, `input-${i}`);
        const bytes = await readFile(this.resolvePath(sources[i].path), { signal });
        totalBytes += bytes.length;
        if (totalBytes > 32 * 1024 * 1024) throw new Error("Image inputs exceed 32 MiB");
        await durableFile(this.resolvePath(target), bytes);
        inputs.push(this.resolvePath(target));
      }
      signal.throwIfAborted();
      if (!this.isOwner() || !this.get(sessionId, image.id)) return;
      const result = await this.generate({ prompt: image.prompt, inputPaths: inputs }, AbortSignal.any([signal, AbortSignal.timeout(300_000)]));
      if (!result.ok) {
        this.finish(sessionId, image.id, { state: "error", waitingFor: [], error: problem("provider_error", result.error.message) });
        return;
      }
      providerCompleted = true;
      await durableFile(this.resolvePath(join(directory, "provider.json")), JSON.stringify({ model: result.model, responseId: result.responseId,
        providerUsage: result.usage, imageIds: result.images.map(output => output.id) }));
      const paths: string[] = [];
      const hashes: string[] = [];
      for (let i = 0; i < result.images.length; i++) {
        const path = join(directory, `${i + 1}.png`);
        await durableFile(this.resolvePath(path), result.images[i].bytes);
        paths.push(path);
        hashes.push(createHash("sha256").update(result.images[i].bytes).digest("hex"));
      }
      if (!paths.length) throw new Error("Provider returned no images");
      const receipt = { path: paths[paths.length - 1], paths, model: result.model, responseId: result.responseId };
      await this.publishReceipt(directory, receipt, hashes);
      this.finish(sessionId, image.id, { ...receipt, state: "complete", error: null });
    } catch (error) {
      this.finish(sessionId, image.id, { state: "error", waitingFor: [], error: problem(providerCompleted ? "publication_error" : "input_error",
        `${error instanceof Error ? error.message : String(error)}. Artifacts: ${directory}. No automatic retry was made.`) });
    }
  }
  private async publishReceipt(directory: string, receipt: Pick<InlineImage, "path" | "paths" | "model" | "responseId">, hashes: string[]) {
    await durableFile(this.resolvePath(join(directory, "receipt.writing")), JSON.stringify({ ...receipt, hashes }));
    await rename(this.resolvePath(join(directory, "receipt.writing")), this.resolvePath(join(directory, "receipt.json")));
    await syncDirectory(this.resolvePath(directory));
  }
  private async recover(directory: string): Promise<Pick<InlineImage, "path" | "paths" | "model" | "responseId"> | null> {
    try {
      const receipt = JSON.parse(await readFile(this.resolvePath(join(directory, "receipt.json")), "utf8"));
      if (!Array.isArray(receipt.paths) || !receipt.paths.length || !Array.isArray(receipt.hashes)
        || receipt.hashes.length !== receipt.paths.length || receipt.path !== receipt.paths.at(-1)
        || !((typeof receipt.model === "string" && typeof receipt.responseId === "string") || (receipt.model === null && receipt.responseId === null))) return null;
      for (let i = 0; i < receipt.paths.length; i++) {
        const extension = extname(receipt.paths[i]).slice(1);
        if (!["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "svg"].includes(extension)
          || receipt.paths[i] !== join(directory, `${i + 1}.${extension}`) || !(await stat(this.resolvePath(receipt.paths[i]))).isFile()) return null;
        if (createHash("sha256").update(await readFile(this.resolvePath(receipt.paths[i]))).digest("hex") !== receipt.hashes[i]) return null;
      }
      return { path: receipt.path, paths: receipt.paths, model: receipt.model, responseId: receipt.responseId };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null;
      throw error;
    }
  }
}
