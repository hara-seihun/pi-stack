import { Database } from "bun:sqlite";
import { isAbsolute, join, relative, resolve } from "node:path";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { InlineImages, adoptImageSchema } from "./image-registry.js";
import { generateImageWithSharedAccount, type SharedImageAccountOwner } from "../image-service.js";
import { authorize } from "../permissions.js";
import type { Resource } from "../permissions.js";
import type { CoreResult } from "./config.js";
import type { CoreRuntime } from "./service.js";
import type { ThreadService } from "../threads/service.js";
import type { Thread } from "../threads/contracts.js";
import { withIndexedThreadHistory } from "../threads/history.mjs";
import { acquireDatabaseOwnership, type ScopeOwnership } from "./ownership.js";

export type CoreImagesSpec = {
  scopeId: string;
  databasePath: string;
  artifactRoot: string;
  adoptionReceiptPath: string;
  allowedRoots: string[];
  dataResource: Resource;
};
export type CoreImagesConfig = { kind: "disabled" } | { kind: "configured"; registries: CoreImagesSpec[] };
export type CoreImageScope = { runtime: Pick<CoreRuntime, "path">; uid: number; allowsThread(id: string): boolean; threads: Pick<ThreadService, "snapshot" | "subscribe"> };
export type CoreImagesOptions = {
  accounts: SharedImageAccountOwner;
  scope(scopeId: string): CoreResult<CoreImageScope>;
  authorize(request: Request, scopeId: string, resource: Resource, actions: readonly ("read" | "execute" | "use")[]): CoreResult<void>;
  authorizeNative(scopeId: string, resource: Resource, actions: readonly ("execute" | "use")[]): CoreResult<void>;
};
export type { SharedImageAccountOwner } from "../image-service.js";
export { InlineImages } from "./image-registry.js";

const invalid = (message: string): CoreResult<never> => ({ ok: false, error: { code: "invalid-config", message } });
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const absolute = (value: unknown): value is string => typeof value === "string" && isAbsolute(value) && resolve(value) === value && !value.includes("\0");
const inside = (root: string, path: string) => { const suffix = relative(root, path); return suffix === "" || !suffix.startsWith("..") && !isAbsolute(suffix); };

export function parseCoreImagesConfig(value: unknown): CoreResult<CoreImagesConfig> {
  if (!record(value)) return invalid("Core images must be explicitly disabled or configured");
  if (value.kind === "disabled" && Object.keys(value).length === 1) return { ok: true, value: { kind: "disabled" } };
  if (value.kind !== "configured" || !Array.isArray(value.registries) || !value.registries.length) return invalid("Configured images require explicit existing registries");
  const scopes = new Set<string>(), databases = new Set<string>();
  for (const item of value.registries) {
    if (!record(item) || typeof item.scopeId !== "string" || !/^[a-zA-Z0-9_.:-]+$/.test(item.scopeId) || scopes.has(item.scopeId)
      || !absolute(item.databasePath) || databases.has(item.databasePath) || !absolute(item.artifactRoot) || !absolute(item.adoptionReceiptPath)
      || !Array.isArray(item.allowedRoots) || !item.allowedRoots.length || !item.allowedRoots.every(absolute)
      || new Set(item.allowedRoots).size !== item.allowedRoots.length) return invalid("Image registry scope, database, artifact root, adoption receipt and allowed path roots must be explicit and unique");
    const resource = authorize({ revision: 1, grants: [], consents: [] }, { principal: { kind: "service", id: "config" }, resource: item.dataResource as Resource, action: "read", now: 0 });
    if (!record(item.dataResource) || item.dataResource.kind !== "data" || !resource.ok && resource.error.code === "invalid-request") return invalid("Image registry requires an explicit valid data resource");
    scopes.add(item.scopeId); databases.add(item.databasePath);
  }
  return { ok: true, value: value as unknown as CoreImagesConfig };
}

type Registry = { spec: CoreImagesSpec; db: Database; images: InlineImages; ownership: ScopeOwnership; scope: CoreImageScope; unsubscribe(): void };
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
      const scope = this.options.scope(spec.scopeId);
      if (!scope.ok) { await this.close(); return scope; }
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
        db.exec(`CREATE TABLE IF NOT EXISTS core_image_sources(thread_id TEXT PRIMARY KEY,source_path TEXT NOT NULL,revision TEXT NOT NULL,last_offset INTEGER NOT NULL,last_digest TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS core_image_ingress_errors(thread_id TEXT NOT NULL,message_key TEXT NOT NULL,error TEXT NOT NULL,PRIMARY KEY(thread_id,message_key));`);
        const receipt = JSON.parse(readFileSync(scope.value.runtime.path(spec.adoptionReceiptPath), "utf8"));
        const watermarks: unknown = receipt.nativeImageSources;
        if (watermarks !== undefined) {
          if (!Array.isArray(watermarks)) throw new Error("Native image source watermarks must be an explicit receipt array");
          for (const watermark of watermarks) {
            if (!record(watermark) || typeof watermark.threadId !== "string" || !watermark.threadId || !absolute(watermark.path)
              || typeof watermark.revision !== "string" || !Number.isSafeInteger(watermark.lastOffset) || Number(watermark.lastOffset) < -1
              || typeof watermark.lastDigest !== "string" || !(Number(watermark.lastOffset) === -1 && watermark.lastDigest === "" || /^[a-f0-9]{64}$/.test(watermark.lastDigest))) throw new Error("Invalid detached native image source watermark");
            db.query("INSERT OR IGNORE INTO core_image_sources VALUES(?,?,?,?,?)").run(watermark.threadId, watermark.path, watermark.revision, Number(watermark.lastOffset), watermark.lastDigest);
          }
        }
        const acceptsPath = (path: string) => {
          const permitted = this.options.authorizeNative(spec.scopeId, spec.dataResource, ["execute", "use"]);
          if (!permitted.ok) throw new Error(permitted.error.message);
          if (!absolute(path) || ![spec.artifactRoot, ...spec.allowedRoots].some(root => inside(root, path))) return false;
          const physical = scope.value.runtime.path(path);
          const real = requireRealPath(physical);
          return [spec.artifactRoot, ...spec.allowedRoots].some(root => inside(requireRealPath(scope.value.runtime.path(root)), real));
        };
        const images = new InlineImages(db, spec.artifactRoot, async (input, signal) => {
          const permitted = this.options.authorizeNative(spec.scopeId, spec.dataResource, ["execute", "use"]);
          if (!permitted.ok) return { ok: false, error: { message: permitted.error.message } };
          return generateImageWithSharedAccount(input, { ...this.options.accounts, signal, cwd: scope.value.runtime.path(spec.artifactRoot) });
        }, () => {}, 2, () => !this.closed, id => scope.value.allowsThread(id), path => scope.value.runtime.path(path), acceptsPath);
        const registry: Registry = { spec, db, images, ownership: ownership.value, scope: scope.value, unsubscribe: () => {} };
        this.registries.set(spec.scopeId, registry);
        registry.unsubscribe = scope.value.threads.subscribe(change => {
          if (!("event" in change) || change.event.type !== "message_end") return;
          const message = change.event.message as { role?: string; content?: unknown } | undefined;
          if (message?.role !== "assistant") return;
          const text = assistantText(message.content);
          if (text.includes("<pi-remote-image")) this.acceptNative(spec.scopeId, change.threadId, messageHash(text), text);
        });
        for (const thread of scope.value.threads.snapshot()) {
          const recovered = this.recoverNative(registry, thread);
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
      if (!registry.scope.allowsThread(input.threadId)) return response("Thread is outside the granted scope", 403);
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
      const snapshots = Object.fromEntries([...ids].filter(id => registry.images.version(id) !== have[id]).map(id => [id, registry.images.snapshot(id)]));
      const errors = (registry.db.query("SELECT error FROM core_image_ingress_errors").all() as { error: string }[]).map(row => row.error);
      return Response.json({ ok: true, value: { snapshots, errors } });
    }
    if (operation && request.method === "GET") {
      let threadId: string;
      try { threadId = decodeURIComponent(operation); } catch { return response("Invalid image thread", 400); }
      if (!registry.scope.allowsThread(threadId)) return response("Thread is outside the granted scope", 403);
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
    const result = permitted.ok ? registry.scope.allowsThread(threadId) ? this.acceptMessage(registry, threadId, messageKey, text)
      : { ok: false as const, error: { code: "ownership-conflict" as const, message: "Native image thread is outside its scope" } } : permitted;
    if (!result.ok) registry.db.query("INSERT INTO core_image_ingress_errors VALUES(?,?,?) ON CONFLICT(thread_id,message_key) DO UPDATE SET error=excluded.error").run(threadId, messageKey, result.error.message);
    return result;
  }

  private recoverNative(registry: Registry, thread: Thread): CoreResult<void> {
    const previous = registry.db.query("SELECT source_path,revision,last_offset,last_digest FROM core_image_sources WHERE thread_id=?").get(thread.id) as { source_path: string; revision: string; last_offset: number; last_digest: string } | null;
    const recovered = withIndexedThreadHistory(registry.scope.runtime.path(thread.sessionFile), undefined, undefined, history => {
      if (previous?.source_path === thread.sessionFile && previous.revision === history.source.revision) return { ok: true as const, value: undefined };
      const boundary = previous && previous.source_path === thread.sessionFile ? history.entries.find(entry => entry.offset === previous.last_offset && entry.digest === previous.last_digest) : undefined;
      const trusted = Boolean(previous && previous.source_path === thread.sessionFile && (boundary || previous.last_offset === -1 && previous.last_digest === ""));
      const after = boundary ? boundary.offset : -1;
      let uncertain = 0;
      for (const descriptor of history.messages) {
        if (descriptor.role !== "assistant" || descriptor.offset <= after) continue;
        const read = history.read(descriptor);
        if (!read.ok) return { ok: false as const, error: { code: "unavailable" as const, message: read.error.message } };
        const text = assistantText(read.value.message?.content);
        if (!text.includes("<pi-remote-image")) continue;
        if (!trusted) {
          const hash = messageHash(text);
          const receipt = registry.db.query("SELECT 1 FROM inline_image_messages WHERE session_id=? AND message_key=?").get(thread.id, hash);
          if (!receipt) uncertain++;
          continue;
        }
        const accepted = this.acceptNative(registry.spec.scopeId, thread.id, messageHash(text), text);
        if (!accepted.ok) return accepted;
      }
      if (uncertain) registry.db.query("INSERT INTO core_image_ingress_errors VALUES(?,'history-gap',?) ON CONFLICT(thread_id,message_key) DO UPDATE SET error=excluded.error").run(thread.id, `${thread.id}: ${uncertain} historical image messages have no trustworthy acceptance watermark. Provider effects are unknown; none were generated during adoption.`);
      const last = history.entries.reduce<typeof history.entries[number] | null>((last, entry) => !last || entry.offset > last.offset ? entry : last, null);
      if (last) registry.db.query("INSERT INTO core_image_sources VALUES(?,?,?,?,?) ON CONFLICT(thread_id) DO UPDATE SET source_path=excluded.source_path,revision=excluded.revision,last_offset=excluded.last_offset,last_digest=excluded.last_digest").run(thread.id, thread.sessionFile, history.source.revision, last.offset, last.digest);
      return { ok: true as const, value: undefined };
    });
    if (!recovered.ok) return recovered.error.code === "missing" ? { ok: true, value: undefined } : { ok: false, error: { code: "unavailable", message: `Native image recovery ${thread.id}: ${recovered.error.message}` } };
    return recovered.value;
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
const requireRealPath = (path: string) => realpathSync(path);
const messageHash = (text: string) => createHash("sha256").update(text).digest("hex");
