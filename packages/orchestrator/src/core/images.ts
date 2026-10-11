import { Database } from "bun:sqlite";
import { isAbsolute, join, relative, resolve } from "node:path";
import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { InlineImages, adoptImageSchema } from "./image-registry.js";
import { generateImageWithSharedAccount, type SharedImageAccountOwner } from "../image-service.js";
import { authorize } from "../permissions.js";
import type { Resource } from "../permissions.js";
import type { CoreResult } from "./config.js";
import type { CoreRuntime } from "./service.js";
import type { ThreadService } from "../threads/service.js";
import type { Thread } from "../threads/contracts.js";
import { captureNativeHistoryWatermark, withNativeHistorySuffix, type NativeHistoryWatermark } from "../threads/history.mjs";
import { acquireDatabaseOwnership, type ScopeOwnership } from "./ownership.js";

export type CoreImagesSpec = {
  scopeId: string;
  databasePath: string;
  artifactRoot: string;
  adoptionReceiptPath: string;
  allowedRoots: string[];
  relatedThreadScopeIds: string[];
  dataResource: Resource;
};
export type CoreImagesConfig = { kind: "disabled" } | { kind: "configured"; registries: CoreImagesSpec[] };
export type CoreImageScope = { runtime: Pick<CoreRuntime, "path" | "readImage">; uid: number; gid: number; allowsThread(id: string): boolean; threads: Pick<ThreadService, "snapshot" | "subscribe"> };
export type CoreImagesOptions = {
  accounts: SharedImageAccountOwner;
  scope(scopeId: string): CoreResult<CoreImageScope | null>;
  relatedScope(registryScopeId: string, relatedScopeId: string): CoreResult<CoreImageScope | null>;
  authorize(request: Request, scopeId: string, resource: Resource, actions: readonly ("read" | "execute" | "use")[]): CoreResult<void>;
  authorizeNative(scopeId: string, resource: Resource, actions: readonly ("execute" | "use")[]): CoreResult<void>;
};
export type { SharedImageAccountOwner } from "../image-service.js";
export { InlineImages } from "./image-registry.js";

const invalid = (message: string): CoreResult<never> => ({ ok: false, error: { code: "invalid-config", message } });
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const absolute = (value: unknown): value is string => typeof value === "string" && isAbsolute(value) && resolve(value) === value && !value.includes("\0");
const inside = (root: string, path: string) => { const suffix = relative(root, path); return suffix === "" || !suffix.startsWith("..") && !isAbsolute(suffix); };
const instant = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
function trustedEmptySource(value: unknown): boolean {
  if (!record(value) || value.lastOffset !== -1 || value.lastDigest !== "" || !record(value.priorSource)) return false;
  const prior = value.priorSource;
  return prior.kind === "absent" && instant(prior.observedAt)
    || prior.kind === "created-after-baseline" && instant(prior.createdAt) && instant(prior.baselineStartedAt) && Date.parse(prior.createdAt) >= Date.parse(prior.baselineStartedAt);
}

export function parseCoreImagesConfig(value: unknown): CoreResult<CoreImagesConfig> {
  if (!record(value)) return invalid("Core images must be explicitly disabled or configured");
  if (value.kind === "disabled" && Object.keys(value).length === 1) return { ok: true, value: { kind: "disabled" } };
  if (value.kind !== "configured" || !Array.isArray(value.registries) || !value.registries.length) return invalid("Configured images require explicit existing registries");
  const scopes = new Set<string>(), databases = new Set<string>();
  for (const item of value.registries) {
    if (!record(item) || typeof item.scopeId !== "string" || !/^[a-zA-Z0-9_.:-]+$/.test(item.scopeId) || scopes.has(item.scopeId)
      || !absolute(item.databasePath) || databases.has(item.databasePath) || !absolute(item.artifactRoot) || !absolute(item.adoptionReceiptPath)
      || !Array.isArray(item.allowedRoots) || !item.allowedRoots.length || !item.allowedRoots.every(absolute)
      || new Set(item.allowedRoots).size !== item.allowedRoots.length
      || !Array.isArray(item.relatedThreadScopeIds) || !item.relatedThreadScopeIds.every(id => typeof id === "string" && /^[a-zA-Z0-9_.:-]+$/.test(id) && id !== item.scopeId)
      || new Set(item.relatedThreadScopeIds).size !== item.relatedThreadScopeIds.length) return invalid("Image registry scope, database, artifact root, adoption receipt and allowed path roots must be explicit and unique");
    const resource = authorize({ revision: 1, grants: [], consents: [] }, { principal: { kind: "service", id: "config" }, resource: item.dataResource as Resource, action: "read", now: 0 });
    if (!record(item.dataResource) || item.dataResource.kind !== "data" || !resource.ok && resource.error.code === "invalid-request") return invalid("Image registry requires an explicit valid data resource");
    scopes.add(item.scopeId); databases.add(item.databasePath);
  }
  return { ok: true, value: value as unknown as CoreImagesConfig };
}

type Registry = { spec: CoreImagesSpec; db: Database; images: InlineImages; ownership: ScopeOwnership; scope: CoreImageScope; sources: CoreImageScope[]; unsubscribe(): void };
const response = (error: string, status: number) => Response.json({ ok: false, error: { code: status === 403 ? "denied" : status === 503 ? "unavailable" : "invalid-request", message: error } }, { status });

export class CoreImages {
  private registries = new Map<string, Registry>();
  private closed = false;
  constructor(private config: CoreImagesConfig, private options: CoreImagesOptions) {}

  async start(): Promise<CoreResult<void>> {
    if (this.closed) return { ok: false, error: { code: "unavailable", message: "Core images are closed" } };
    if (this.config.kind === "disabled") return { ok: true, value: undefined };
    for (const spec of this.config.registries) {
      if (this.registries.has(spec.scopeId)) return invalid("Core images already started");
      const resolved = this.options.scope(spec.scopeId);
      if (!resolved.ok) { await this.close(); return resolved; }
      if (resolved.value === null) continue;
      const scope = { value: resolved.value };
      const sources = [scope.value];
      for (const id of spec.relatedThreadScopeIds) {
        const related = this.options.relatedScope(spec.scopeId, id);
        if (!related.ok) { await this.close(); return related; }
        if (related.value === null) continue;
        if (related.value.uid !== scope.value.uid || related.value.gid !== scope.value.gid) { await this.close(); return invalid("Related image thread scope has a different owning Unix identity"); }
        sources.push(related.value);
      }
      const acceptsThread = (id: string) => sources.some(source => source.allowsThread(id));
      const ownership = acquireDatabaseOwnership({ id: `${spec.scopeId}:images`, databasePath: spec.databasePath, adoptionReceiptPath: spec.adoptionReceiptPath, uid: scope.value.uid, requiredTables: ["inline_images", "inline_image_versions", "inline_image_messages", "core_image_acceptance", "core_image_sources", "core_image_ingress_errors", "core_image_threads"] }, path => scope.value.runtime.path(path));
      if (!ownership.ok) { await this.close(); return ownership; }
      let db: Database | undefined;
      try {
        const artifact = statSync(scope.value.runtime.path(spec.artifactRoot));
        if (!artifact.isDirectory()) throw new Error("Existing image artifact root is unavailable");
        db = new Database(scope.value.runtime.path(spec.databasePath), { create: false, strict: true });
        db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
        for (const table of ["inline_images", "inline_image_versions", "inline_image_messages"]) {
          if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) throw new Error(`Existing image table ${table} is unavailable; adoption never creates a replacement registry`);
        }
        adoptImageSchema(db);
        db.exec(`CREATE TABLE IF NOT EXISTS core_image_sources(thread_id TEXT PRIMARY KEY,source_path TEXT NOT NULL,revision TEXT NOT NULL,last_offset INTEGER NOT NULL,last_digest TEXT NOT NULL,watermark_json TEXT);
          CREATE TABLE IF NOT EXISTS core_image_ingress_errors(thread_id TEXT NOT NULL,message_key TEXT NOT NULL,error TEXT NOT NULL,PRIMARY KEY(thread_id,message_key));`);
        const sourceColumns = db.query("PRAGMA table_info(core_image_sources)").all() as { name: string }[];
        if (!sourceColumns.some(column => column.name === "watermark_json")) db.exec("ALTER TABLE core_image_sources ADD COLUMN watermark_json TEXT");
        const receipt = JSON.parse(readFileSync(scope.value.runtime.path(spec.adoptionReceiptPath), "utf8"));
        const watermarks: unknown = receipt.nativeImageSources;
        if (watermarks !== undefined) {
          if (!Array.isArray(watermarks)) throw new Error("Native image source watermarks must be an explicit receipt array");
          for (const watermark of watermarks) {
            if (!record(watermark) || typeof watermark.threadId !== "string" || !watermark.threadId || !absolute(watermark.path)
              || typeof watermark.revision !== "string" || !Number.isSafeInteger(watermark.lastOffset) || Number(watermark.lastOffset) < -1
              || typeof watermark.lastDigest !== "string" || !(Number(watermark.lastOffset) === -1 && watermark.lastDigest === "" || /^[a-f0-9]{64}$/.test(watermark.lastDigest))) throw new Error("Invalid detached native image source watermark");
            if (watermark.priorSource !== undefined && !trustedEmptySource(watermark)) throw new Error("Invalid absent or created-after-baseline native source receipt");
            db.query("INSERT OR IGNORE INTO core_image_sources(thread_id,source_path,revision,last_offset,last_digest,watermark_json) VALUES(?,?,?,?,?,?)").run(watermark.threadId, watermark.path, watermark.revision, Number(watermark.lastOffset), watermark.lastDigest, watermark.kind === "native-jsonl-watermark" || trustedEmptySource(watermark) ? JSON.stringify(watermark) : null);
          }
        }
        const acceptsPath = (path: string) => {
          const permitted = this.options.authorizeNative(spec.scopeId, spec.dataResource, ["execute", "use"]);
          if (!permitted.ok) throw new Error(permitted.error.message);
          if (!absolute(path) || ![spec.artifactRoot, ...spec.allowedRoots].some(root => inside(root, path))) return false;
          return true;
        };
        const images = new InlineImages(db, spec.artifactRoot, async (input, signal) => {
          const permitted = this.options.authorizeNative(spec.scopeId, spec.dataResource, ["execute", "use"]);
          if (!permitted.ok) return { ok: false, error: { message: permitted.error.message } };
          return generateImageWithSharedAccount({ prompt: input.prompt, inputBytes: input.inputBytes }, { ...this.options.accounts, signal });
        }, () => {}, 2, () => !this.closed, acceptsThread, path => scope.value.runtime.path(path), acceptsPath,
          async (path, signal) => {
            if (!acceptsPath(path)) return { ok: false, error: { message: "Image path is outside its granted roots" } };
            return scope.value.runtime.readImage(path, [spec.artifactRoot, ...spec.allowedRoots], signal);
          }, { uid: scope.value.uid, gid: scope.value.gid });
        const registry: Registry = { spec, db, images, ownership: ownership.value, scope: scope.value, sources, unsubscribe: () => {} };
        this.registries.set(spec.scopeId, registry);
        const unsubscribers = sources.map(source => source.threads.subscribe(change => {
          if (!("event" in change) || change.event.type !== "message_end") return;
          const message = change.event.message as { role?: string; content?: unknown } | undefined;
          if (message?.role !== "assistant") return;
          const text = assistantText(message.content);
          if (text.includes("<pi-remote-image")) this.acceptNative(spec.scopeId, change.threadId, messageHash(text), text);
        }));
        registry.unsubscribe = () => { for (const unsubscribe of unsubscribers) unsubscribe(); };
        for (const source of sources) for (const thread of source.threads.snapshot()) {
          const recovered = this.recoverNative(registry, thread, source);
          if (!recovered.ok) throw new Error(recovered.error.message);
        }
        await images.start();
      } catch (cause) {
        if (!this.registries.has(spec.scopeId)) { db?.close(); ownership.value.close(); }
        await this.close();
        return { ok: false, error: { code: "unavailable", message: `Image registry adoption failed: ${String(cause)}` } };
      }
    }
    return { ok: true, value: undefined };
  }

  async handle(request: Request): Promise<Response | null> {
    try { return await this.handleRequest(request); }
    catch (cause) { return response(`Core image operation failed: ${String(cause)}`, 503); }
  }
  private async handleRequest(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    const match = /^\/v1\/scopes\/([^/]+)\/images(?:\/(accept|sync|[^/]+))?$/.exec(url.pathname);
    if (!match) return null;
    let scopeId: string;
    try { scopeId = decodeURIComponent(match[1]!); } catch { return response("Invalid image scope", 400); }
    const registry = this.registries.get(scopeId);
    if (!registry || this.closed) return response("Image registry is not adopted in this scope", 503);
    const operation = match[2];
    const write = operation === "accept";
    const permitted = this.options.authorize(request, scopeId, registry.spec.dataResource, write ? ["execute", "use"] : ["read"]);
    if (!permitted.ok) return response(permitted.error.message, permitted.error.code === "unavailable" ? 503 : 403);
    if (write && request.method === "POST") {
      let input: unknown;
      try { input = await request.json(); } catch { return response("Image acceptance requires JSON", 400); }
      if (!record(input) || Object.keys(input).some(key => !["threadId", "messageKey", "text"].includes(key))
        || typeof input.threadId !== "string" || !input.threadId || typeof input.messageKey !== "string" || !input.messageKey || input.messageKey.length > 512
        || typeof input.text !== "string" || Buffer.byteLength(input.text) > 8 * 1024 * 1024) return response("Invalid finalized image message", 400);
      const threadId = input.threadId;
      if (!registry.sources.some(source => source.allowsThread(threadId))) return response("Thread is outside the granted scope", 403);
      const accepted = this.acceptMessage(registry, input.threadId, input.messageKey, input.text);
      if (!accepted.ok) return response(accepted.error.message, accepted.error.code === "ownership-conflict" ? 409 : 503);
      return Response.json({ ok: true, value: registry.images.snapshot(input.threadId) });
    }
    if (operation === "sync" && request.method === "POST") {
      let input: unknown;
      try { input = await request.json(); } catch { return response("Image sync requires JSON", 400); }
      if (!record(input) || !record(input.have) || Object.keys(input).some(key => key !== "have") || Object.values(input.have).some(version => !Number.isSafeInteger(version) || Number(version) < 0)) return response("Image sync requires explicit known versions", 400);
      const have = input.have as Record<string, number>;
      const versions = registry.db.query("SELECT session_id,version FROM inline_image_versions").all() as { session_id: string; version: number }[];
      const ids = new Set([...Object.keys(have), ...versions.map(row => row.session_id)]);
      const snapshots = Object.fromEntries([...ids].filter(id => registry.sources.some(source => source.allowsThread(id)) && registry.images.version(id) !== have[id]).map(id => [id, registry.images.snapshot(id)]));
      const errors = (registry.db.query("SELECT error FROM core_image_ingress_errors").all() as { error: string }[]).map(row => row.error);
      return Response.json({ ok: true, value: { snapshots, errors } });
    }
    if (operation && request.method === "GET") {
      let threadId: string;
      try { threadId = decodeURIComponent(operation); } catch { return response("Invalid image thread", 400); }
      if (!registry.sources.some(source => source.allowsThread(threadId))) return response("Thread is outside the granted scope", 403);
      return Response.json({ ok: true, value: registry.images.snapshot(threadId) });
    }
    return response("Unknown image operation", 404);
  }

  private acceptMessage(registry: Registry, threadId: string, messageKey: string, text: string): CoreResult<void> {
    try {
      const hash = messageHash(text);
      const previous = registry.db.query("SELECT text_hash FROM core_image_acceptance WHERE thread_id=? AND message_key=?").get(threadId, messageKey) as { text_hash: string } | null;
      if (previous && previous.text_hash !== hash) return { ok: false, error: { code: "ownership-conflict", message: "Image message identity belongs to different text" } };
      registry.db.transaction(() => {
        registry.db.query("INSERT OR IGNORE INTO core_image_threads(id) VALUES(?)").run(threadId);
        registry.images.accept(threadId, messageKey, text);
        registry.db.query("INSERT OR IGNORE INTO core_image_acceptance VALUES(?,?,?)").run(threadId, messageKey, hash);
        registry.db.query("DELETE FROM core_image_ingress_errors WHERE thread_id=? AND message_key=?").run(threadId, messageKey);
      })();
      return { ok: true, value: undefined };
    } catch (cause) { return { ok: false, error: { code: "unavailable", message: `Image message acceptance failed: ${String(cause)}` } }; }
  }

  acceptNative(scopeId: string, threadId: string, messageKey: string, text: string): CoreResult<void> {
    const registry = this.registries.get(scopeId);
    if (!registry || this.closed) return { ok: false, error: { code: "unavailable", message: "Native image registry is unavailable" } };
    const permitted = this.options.authorizeNative(scopeId, registry.spec.dataResource, ["execute", "use"]);
    const result = permitted.ok ? registry.sources.some(source => source.allowsThread(threadId)) ? this.acceptMessage(registry, threadId, messageKey, text)
      : { ok: false as const, error: { code: "ownership-conflict" as const, message: "Native image thread is outside its scope" } } : permitted;
    if (!result.ok) registry.db.query("INSERT INTO core_image_ingress_errors VALUES(?,?,?) ON CONFLICT(thread_id,message_key) DO UPDATE SET error=excluded.error").run(threadId, messageKey, result.error.message);
    return result;
  }

  private recoverNative(registry: Registry, thread: Thread, source: CoreImageScope): CoreResult<void> {
    const previous = registry.db.query("SELECT source_path,watermark_json FROM core_image_sources WHERE thread_id=?").get(thread.id) as { source_path: string; watermark_json: string | null } | null;
    if (previous?.source_path === thread.sessionFile && previous.watermark_json !== null) {
      const proof: unknown = JSON.parse(previous.watermark_json);
      if (trustedEmptySource(proof) && record(proof) && record(proof.priorSource) && proof.priorSource.kind === "absent") {
        try { statSync(thread.sessionFile); }
        catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
          registry.db.query("INSERT INTO core_image_ingress_errors VALUES(?,?,?) ON CONFLICT(thread_id,message_key) DO UPDATE SET error=excluded.error").run(thread.id, "source-missing", "Original source remains absent at its captured path; historical effects remain unknown and were not generated.");
          return { ok: true, value: undefined };
        }
      }
    }
    const path = source.runtime.path(thread.sessionFile);
    const checkpoint = (watermark: NativeHistoryWatermark) => registry.db.query(`INSERT INTO core_image_sources(thread_id,source_path,revision,last_offset,last_digest,watermark_json) VALUES(?,?,?,?,?,?)
      ON CONFLICT(thread_id) DO UPDATE SET source_path=excluded.source_path,revision=excluded.revision,last_offset=excluded.last_offset,last_digest=excluded.last_digest,watermark_json=excluded.watermark_json`).run(thread.id, thread.sessionFile, watermark.revision, watermark.lastOffset, watermark.lastDigest, JSON.stringify(watermark));
    const uncertainty = (key: string, detail: string) => registry.db.query("INSERT INTO core_image_ingress_errors VALUES(?,?,?) ON CONFLICT(thread_id,message_key) DO UPDATE SET error=excluded.error").run(thread.id, key, `${thread.id}: ${detail}. Historical effects remain unknown; no uncertain record was generated.`);
    if (previous?.source_path === thread.sessionFile && previous.watermark_json !== null) {
      let proof: unknown;
      try { proof = JSON.parse(previous.watermark_json); }
      catch { return { ok: false, error: { code: "unavailable", message: `Native image source proof ${thread.id} is invalid JSON` } }; }
      let watermark = proof as NativeHistoryWatermark;
      if (trustedEmptySource(proof)) {
        const captured = captureNativeHistoryWatermark(path);
        if (!captured.ok) return captured.error.code === "missing" ? { ok: true, value: undefined } : { ok: false, error: { code: "unavailable", message: captured.error.message } };
        watermark = { ...captured.value, size: 0, closedOffset: 0, prefixDigest: messageHash(""), lastOffset: -1, lastLength: 0, lastLine: 0, lastDigest: "", nextLine: 1 };
      }
      const recovered = withNativeHistorySuffix(path, watermark, records => {
        const messages: string[] = [], errors: { key: string; detail: string }[] = [];
        for (const record of records) {
          if (record.kind === "uncertain") { errors.push({ key: `native-offset:${record.descriptor.offset}`, detail: record.error.message }); continue; }
          const entry = record.entry as { type?: string; message?: { role?: string; content?: unknown } };
          if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
          const text = assistantText(entry.message.content);
          if (text.includes("<pi-remote-image")) messages.push(text);
        }
        return { messages, errors };
      });
      if (recovered.ok) {
        registry.db.transaction(() => {
          for (const error of recovered.value.value.errors) uncertainty(error.key, error.detail);
          for (const text of recovered.value.value.messages) this.acceptNative(registry.spec.scopeId, thread.id, messageHash(text), text);
          checkpoint(recovered.value.watermark);
        })();
        return { ok: true, value: undefined };
      }
      if (recovered.error.code === "missing") return { ok: true, value: undefined };
      if (recovered.error.code !== "stale-source" && recovered.error.code !== "invalid-watermark") return { ok: false, error: { code: "unavailable", message: recovered.error.message } };
      uncertainty("history-gap", `Native source proof could not be conserved: ${recovered.error.message}`);
    }
    const captured = captureNativeHistoryWatermark(path);
    if (!captured.ok) return captured.error.code === "missing" ? { ok: true, value: undefined } : { ok: false, error: { code: "unavailable", message: `Native image metadata ${thread.id}: ${captured.error.message}` } };
    if (captured.value.closedOffset > 0) uncertainty("history-gap", "Historical prefix has no full trustworthy source watermark and was not parsed or replayed");
    checkpoint(captured.value);
    return { ok: true, value: undefined };
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.registries.values()].map(async registry => {
      registry.unsubscribe(); await registry.images.close(); registry.db.close(); registry.ownership.close();
    }));
    this.registries.clear();
  }
}

const assistantText = (content: unknown): string => typeof content === "string" ? content : Array.isArray(content)
  ? content.filter(block => block?.type === "text" && typeof block.text === "string").map(block => block.text).join("") : "";
const messageHash = (text: string) => createHash("sha256").update(text).digest("hex");
