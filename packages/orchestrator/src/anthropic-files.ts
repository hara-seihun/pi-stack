import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { acquireDirectoryLock } from "./auth/directory-lock.js";

const CACHE_VERSION = 1;
const DEFAULT_EXPIRY_SECONDS = 7_776_000;
const MIN_EXPIRY_SECONDS = 3_600;
const MAX_EXPIRY_SECONDS = 7_776_000;
const METADATA_CONCURRENCY = 8;
const UPLOAD_CONCURRENCY = 4;
const FILE_LIFETIME_MARGIN_MS = 5 * 60_000;
const IMAGE_MIME_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);

export type AnthropicFilesFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface AnthropicImagesOptions<T> {
  readonly payload: T;
  readonly cacheRoot: string;
  readonly scope: string;
  readonly baseUrl: string;
  readonly headers: HeadersInit;
  readonly signal: AbortSignal;
  readonly fetch?: AnthropicFilesFetch;
  readonly expiresInSeconds?: number;
  readonly now?: () => number;
}

export type AnthropicFilesErrorKind =
  | "cancelled"
  | "invalid-input"
  | "invalid-image"
  | "cache"
  | "transport"
  | "provider"
  | "invalid-response";

export interface AnthropicFilesError {
  readonly kind: AnthropicFilesErrorKind;
  readonly message: string;
  readonly operation?: "metadata" | "upload";
  readonly status?: number;
  readonly providerType?: string;
}

export type AnthropicImagesResult<T> =
  | { readonly ok: true; readonly value: T; readonly uploaded: number; readonly reused: number }
  | { readonly ok: false; readonly error: AnthropicFilesError };

type Failure = { readonly ok: false; readonly error: AnthropicFilesError };
type Result<T> = { readonly ok: true; readonly value: T } | Failure;

type JsonObject = Record<string, unknown>;

interface SourceImage {
  readonly digest: string;
  readonly bytes: Buffer;
  readonly mimeType: string;
}

interface CacheEntry {
  readonly fileId: string;
  readonly expiresAt: number;
  readonly mimeType: string;
  readonly byteLength: number;
}

interface CacheFile {
  readonly version: 1;
  readonly scope: string;
  readonly files: Record<string, CacheEntry>;
}

interface RemoteFile {
  readonly fileId: string;
  readonly expiresAt: number;
}

function failure(kind: AnthropicFilesErrorKind, message: string, details: Partial<AnthropicFilesError> = {}): Failure {
  return { ok: false, error: { kind, message, ...details } };
}

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function filesUrl(baseUrl: string): Result<URL> {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return failure("invalid-input", `Invalid Anthropic base URL: ${baseUrl}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return failure("invalid-input", `Unsupported Anthropic base URL protocol: ${url.protocol}`);
  }
  if (url.username !== "" || url.password !== "") {
    return failure("invalid-input", "Anthropic base URL must not contain credentials");
  }
  url.search = "";
  url.hash = "";
  const path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/v1/files")) url.pathname = path;
  else if (path.endsWith("/v1/messages")) url.pathname = `${path.slice(0, -"messages".length)}files`;
  else if (path.endsWith("/v1")) url.pathname = `${path}/files`;
  else url.pathname = `${path}/v1/files`;
  return { ok: true, value: url };
}

function requestHeaders(input: HeadersInit): Result<Headers> {
  try {
    const headers = new Headers(input);
    headers.delete("content-length");
    headers.delete("content-type");
    return { ok: true, value: headers };
  } catch (cause) {
    return failure("invalid-input", `Invalid Anthropic request headers: ${errorMessage(cause)}`);
  }
}

function base64Value(code: number): number {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  if (code === 43) return 62;
  if (code === 47) return 63;
  return -1;
}

function isCanonicalBase64(data: string): boolean {
  if (data.length === 0 || data.length % 4 !== 0) return false;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const contentLength = data.length - padding;
  for (let index = 0; index < contentLength; index++) {
    if (base64Value(data.charCodeAt(index)) < 0) return false;
  }
  for (let index = contentLength; index < data.length; index++) {
    if (data.charCodeAt(index) !== 61) return false;
  }
  if (padding === 2 && (base64Value(data.charCodeAt(contentLength - 1)) & 15) !== 0) return false;
  if (padding === 1 && (base64Value(data.charCodeAt(contentLength - 1)) & 3) !== 0) return false;
  return true;
}

function decodeImage(data: string, mimeType: string): Result<SourceImage> {
  if (!IMAGE_MIME_TYPES.has(mimeType)) {
    return failure("invalid-image", `Anthropic Files does not support image media type ${mimeType}`);
  }
  if (!isCanonicalBase64(data)) {
    return failure("invalid-image", "Anthropic image source contains invalid base64 data");
  }
  const bytes = Buffer.from(data, "base64");
  return {
    ok: true,
    value: {
      digest: createHash("sha256").update(bytes).digest("hex"),
      bytes,
      mimeType,
    },
  };
}

function collectContentImages(content: unknown, images: Map<string, SourceImage>): Result<void> {
  if (!Array.isArray(content)) return { ok: true, value: undefined };
  for (const value of content) {
    const block = object(value);
    if (block === undefined) continue;
    if (block.type === "image") {
      const source = object(block.source);
      if (source?.type === "file" || source?.type === "url") continue;
      if (source?.type !== "base64" || typeof source.media_type !== "string" || typeof source.data !== "string") {
        return failure("invalid-image", "Anthropic image block has an unsupported source");
      }
      const decoded = decodeImage(source.data, source.media_type);
      if (!decoded.ok) return decoded;
      if (!images.has(decoded.value.digest)) images.set(decoded.value.digest, decoded.value);
      continue;
    }
    if (block.type === "tool_result") {
      const nested = collectContentImages(block.content, images);
      if (!nested.ok) return nested;
    }
  }
  return { ok: true, value: undefined };
}

function collectImages(payload: unknown): Result<Map<string, SourceImage>> {
  const root = object(payload);
  if (root === undefined || !Array.isArray(root.messages)) {
    return failure("invalid-input", "Anthropic payload must contain a messages array");
  }
  const images = new Map<string, SourceImage>();
  for (const value of root.messages) {
    const message = object(value);
    if (message === undefined) return failure("invalid-input", "Anthropic payload contains an invalid message");
    const collected = collectContentImages(message.content, images);
    if (!collected.ok) return collected;
  }
  return { ok: true, value: images };
}

function imageDigest(block: JsonObject): string | undefined {
  const source = object(block.source);
  if (source?.type !== "base64" || typeof source.data !== "string") return undefined;
  return createHash("sha256").update(Buffer.from(source.data, "base64")).digest("hex");
}

function rewriteContent(content: unknown, files: ReadonlyMap<string, CacheEntry>): unknown {
  if (!Array.isArray(content)) return content;
  return content.map(value => {
    const block = object(value);
    if (block === undefined) return value;
    if (block.type === "image") {
      const digest = imageDigest(block);
      const file = digest === undefined ? undefined : files.get(digest);
      return file === undefined ? value : { ...block, source: { type: "file", file_id: file.fileId } };
    }
    if (block.type === "tool_result" && Array.isArray(block.content)) {
      return { ...block, content: rewriteContent(block.content, files) };
    }
    return value;
  });
}

function rewritePayload<T>(payload: T, files: ReadonlyMap<string, CacheEntry>): T {
  const root = payload as JsonObject;
  return {
    ...root,
    messages: (root.messages as unknown[]).map(value => {
      const message = value as JsonObject;
      return Array.isArray(message.content)
        ? { ...message, content: rewriteContent(message.content, files) }
        : value;
    }),
  } as T;
}

function cacheEntry(value: unknown): CacheEntry | undefined {
  const raw = object(value);
  return typeof raw?.fileId === "string" && raw.fileId.length > 0
    && typeof raw.expiresAt === "number" && Number.isFinite(raw.expiresAt)
    && typeof raw.mimeType === "string" && IMAGE_MIME_TYPES.has(raw.mimeType)
    && typeof raw.byteLength === "number" && Number.isSafeInteger(raw.byteLength) && raw.byteLength >= 0
    ? raw as unknown as CacheEntry
    : undefined;
}

function readCache(path: string, scope: string): Result<CacheFile> {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (cause: any) {
    if (cause?.code === "ENOENT") return { ok: true, value: { version: CACHE_VERSION, scope, files: {} } };
    return failure("cache", `Could not read Anthropic file cache: ${errorMessage(cause)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (cause) {
    return failure("cache", `Anthropic file cache is not valid JSON: ${errorMessage(cause)}`);
  }
  const raw = object(parsed);
  const rawFiles = object(raw?.files);
  if (raw?.version !== CACHE_VERSION || raw.scope !== scope || rawFiles === undefined) {
    return failure("cache", "Anthropic file cache has an invalid schema or scope");
  }
  const files: Record<string, CacheEntry> = {};
  for (const [digest, value] of Object.entries(rawFiles)) {
    const entry = cacheEntry(value);
    if (!/^[a-f0-9]{64}$/.test(digest) || entry === undefined) {
      return failure("cache", "Anthropic file cache contains an invalid entry");
    }
    files[digest] = entry;
  }
  return { ok: true, value: { version: CACHE_VERSION, scope, files } };
}

function writeCache(path: string, cache: CacheFile): Result<void> {
  const directoryPath = dirname(path);
  const temporary = join(directoryPath, `.anthropic-files-${randomUUID()}.tmp`);
  try {
    mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
    writeFileSync(temporary, `${JSON.stringify(cache, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(temporary, 0o600);
    const file = openSync(temporary, "r");
    try { fsyncSync(file); } finally { closeSync(file); }
    renameSync(temporary, path);
    const directory = openSync(directoryPath, "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
    return { ok: true, value: undefined };
  } catch (cause) {
    try { rmSync(temporary, { force: true }); } catch {}
    return failure("cache", `Could not write Anthropic file cache: ${errorMessage(cause)}`);
  }
}

async function responseError(response: Response, operation: "metadata" | "upload"): Promise<AnthropicFilesError> {
  let raw = "";
  try { raw = await response.text(); } catch {}
  let providerType: string | undefined;
  let providerMessage: string | undefined;
  try {
    const body = object(JSON.parse(raw));
    const error = object(body?.error);
    if (typeof error?.type === "string") providerType = error.type;
    if (typeof error?.message === "string") providerMessage = error.message;
  } catch {}
  return {
    kind: "provider",
    operation,
    status: response.status,
    providerType,
    message: providerMessage ?? `Anthropic Files ${operation} request failed with HTTP ${response.status}`,
  };
}

function remoteFile(value: unknown, operation: "metadata" | "upload"): Result<RemoteFile> {
  const raw = object(value);
  if (typeof raw?.id !== "string" || raw.id.length === 0 || typeof raw.expires_at !== "string") {
    return failure("invalid-response", "Anthropic Files response omitted id or expires_at", { operation });
  }
  const expiresAt = Date.parse(raw.expires_at);
  if (!Number.isFinite(expiresAt)) {
    return failure("invalid-response", "Anthropic Files response contains an invalid expires_at", { operation });
  }
  return { ok: true, value: { fileId: raw.id, expiresAt } };
}

async function fetchMetadata(
  endpoint: URL,
  fileId: string,
  headers: Headers,
  fetcher: AnthropicFilesFetch,
  signal: AbortSignal,
): Promise<Result<RemoteFile | undefined>> {
  const url = new URL(`${endpoint.href.replace(/\/$/, "")}/${encodeURIComponent(fileId)}`);
  if (signal.aborted) return failure("cancelled", "Anthropic Files operation was cancelled", { operation: "metadata" });
  let response: Response;
  try {
    response = await fetcher(url, { method: "GET", headers, signal });
  } catch (cause) {
    if (signal.aborted) return failure("cancelled", "Anthropic Files operation was cancelled", { operation: "metadata" });
    return failure("transport", `Anthropic Files metadata request failed: ${errorMessage(cause)}`, { operation: "metadata" });
  }
  if (response.status === 404 || response.status === 410) return { ok: true, value: undefined };
  if (!response.ok) return { ok: false, error: await responseError(response, "metadata") };
  let body: unknown;
  try { body = await response.json(); }
  catch (cause) { return failure("invalid-response", `Anthropic Files metadata response is not valid JSON: ${errorMessage(cause)}`, { operation: "metadata" }); }
  return remoteFile(body, "metadata");
}

async function validateCachedFiles(
  endpoint: URL,
  files: ReadonlyArray<readonly [string, CacheEntry]>,
  headers: Headers,
  fetcher: AnthropicFilesFetch,
  signal: AbortSignal,
  minimumExpiresAt: number,
): Promise<Result<Map<string, CacheEntry>>> {
  const valid = new Map<string, CacheEntry>();
  for (let offset = 0; offset < files.length; offset += METADATA_CONCURRENCY) {
    const batch = files.slice(offset, offset + METADATA_CONCURRENCY);
    const results = await Promise.all(batch.map(async ([digest, entry]) => ({
      digest,
      entry,
      metadata: await fetchMetadata(endpoint, entry.fileId, headers, fetcher, signal),
    })));
    for (const result of results) {
      if (!result.metadata.ok) return result.metadata;
      const metadata = result.metadata.value;
      if (metadata === undefined || metadata.fileId !== result.entry.fileId || metadata.expiresAt <= minimumExpiresAt) continue;
      valid.set(result.digest, { ...result.entry, expiresAt: metadata.expiresAt });
    }
  }
  return { ok: true, value: valid };
}

function extension(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  return mimeType.slice("image/".length);
}

async function uploadImage(
  endpoint: URL,
  image: SourceImage,
  headers: Headers,
  fetcher: AnthropicFilesFetch,
  signal: AbortSignal,
  expiresInSeconds: number,
  minimumExpiresAt: number,
): Promise<Result<CacheEntry>> {
  const form = new FormData();
  form.append("file", new Blob([Uint8Array.from(image.bytes)], { type: image.mimeType }), `${image.digest}.${extension(image.mimeType)}`);
  form.append("expires_in_seconds", String(expiresInSeconds));
  if (signal.aborted) return failure("cancelled", "Anthropic Files operation was cancelled", { operation: "upload" });
  let response: Response;
  try {
    response = await fetcher(endpoint, { method: "POST", headers, body: form, signal });
  } catch (cause) {
    if (signal.aborted) return failure("cancelled", "Anthropic Files operation was cancelled", { operation: "upload" });
    return failure("transport", `Anthropic Files upload failed: ${errorMessage(cause)}`, { operation: "upload" });
  }
  if (!response.ok) return { ok: false, error: await responseError(response, "upload") };
  let body: unknown;
  try { body = await response.json(); }
  catch (cause) { return failure("invalid-response", `Anthropic Files upload response is not valid JSON: ${errorMessage(cause)}`, { operation: "upload" }); }
  const file = remoteFile(body, "upload");
  if (!file.ok) return file;
  if (file.value.expiresAt <= minimumExpiresAt) {
    return failure("invalid-response", "Anthropic Files upload returned a file without enough remaining lifetime", { operation: "upload" });
  }
  return {
    ok: true,
    value: {
      fileId: file.value.fileId,
      expiresAt: file.value.expiresAt,
      mimeType: image.mimeType,
      byteLength: image.bytes.byteLength,
    },
  };
}

export async function rewriteAnthropicImages<T>(options: AnthropicImagesOptions<T>): Promise<AnthropicImagesResult<T>> {
  if (options.signal.aborted) return failure("cancelled", "Anthropic Files operation was cancelled");
  if (options.cacheRoot.trim() === "" || options.scope.trim() === "") {
    return failure("invalid-input", "Anthropic Files cacheRoot and scope must not be empty");
  }
  const expiry = options.expiresInSeconds ?? DEFAULT_EXPIRY_SECONDS;
  if (!Number.isInteger(expiry) || expiry < MIN_EXPIRY_SECONDS || expiry > MAX_EXPIRY_SECONDS) {
    return failure("invalid-input", `expiresInSeconds must be an integer from ${MIN_EXPIRY_SECONDS} through ${MAX_EXPIRY_SECONDS}`);
  }
  const endpoint = filesUrl(options.baseUrl);
  if (!endpoint.ok) return endpoint;
  const headers = requestHeaders(options.headers);
  if (!headers.ok) return headers;
  const collected = collectImages(options.payload);
  if (!collected.ok) return collected;
  if (collected.value.size === 0) return { ok: true, value: options.payload, uploaded: 0, reused: 0 };

  const now = options.now ?? Date.now;
  const scopeKey = createHash("sha256").update(`${endpoint.value.href}\0${options.scope}`).digest("hex");
  const cachePath = join(options.cacheRoot, `${scopeKey}.json`);
  try {
    mkdirSync(options.cacheRoot, { recursive: true, mode: 0o700 });
  } catch (cause) {
    return failure("cache", `Could not create Anthropic file cache directory: ${errorMessage(cause)}`);
  }

  let release: (() => void) | undefined;
  try {
    release = await acquireDirectoryLock(cachePath, options.signal, "Timed out waiting for the Anthropic file cache lock");
  } catch (cause) {
    if (options.signal.aborted) return failure("cancelled", "Anthropic Files operation was cancelled");
    return failure("cache", `Could not lock Anthropic file cache: ${errorMessage(cause)}`);
  }

  try {
    const currentTime = now();
    const minimumExpiresAt = currentTime + FILE_LIFETIME_MARGIN_MS;
    const cache = readCache(cachePath, scopeKey);
    if (!cache.ok) return cache;
    let changed = false;
    for (const [digest, entry] of Object.entries(cache.value.files)) {
      if (entry.expiresAt <= minimumExpiresAt) {
        delete cache.value.files[digest];
        changed = true;
      }
    }
    if (changed) {
      const saved = writeCache(cachePath, cache.value);
      if (!saved.ok) return saved;
      changed = false;
    }

    const candidates = [...collected.value.keys()]
      .map(digest => [digest, cache.value.files[digest]] as const)
      .filter((value): value is readonly [string, CacheEntry] => value[1] !== undefined);
    const validated = await validateCachedFiles(
      endpoint.value,
      candidates,
      headers.value,
      options.fetch ?? globalThis.fetch,
      options.signal,
      minimumExpiresAt,
    );
    if (!validated.ok) return validated;

    for (const [digest] of candidates) {
      const valid = validated.value.get(digest);
      if (valid === undefined) {
        delete cache.value.files[digest];
        changed = true;
      } else if (cache.value.files[digest]?.expiresAt !== valid.expiresAt) {
        cache.value.files[digest] = valid;
        changed = true;
      }
    }
    if (changed) {
      const saved = writeCache(cachePath, cache.value);
      if (!saved.ok) return saved;
    }

    let uploaded = 0;
    const missing = [...collected.value]
      .filter(([digest]) => cache.value.files[digest] === undefined);
    for (let offset = 0; offset < missing.length; offset += UPLOAD_CONCURRENCY) {
      const batch = missing.slice(offset, offset + UPLOAD_CONCURRENCY);
      const results = await Promise.all(batch.map(async ([digest, image]) => ({
        digest,
        result: await uploadImage(
          endpoint.value,
          image,
          headers.value,
          options.fetch ?? globalThis.fetch,
          options.signal,
          expiry,
          minimumExpiresAt,
        ),
      })));
      let batchFailure: Failure | undefined;
      let batchUploaded = 0;
      for (const item of results) {
        if (!item.result.ok) {
          batchFailure ??= item.result;
          continue;
        }
        cache.value.files[item.digest] = item.result.value;
        batchUploaded++;
      }
      if (batchUploaded > 0) {
        const saved = writeCache(cachePath, cache.value);
        if (!saved.ok) return saved;
        uploaded += batchUploaded;
      }
      if (batchFailure !== undefined) return batchFailure;
    }

    const used = new Map<string, CacheEntry>();
    for (const digest of collected.value.keys()) used.set(digest, cache.value.files[digest]!);
    return {
      ok: true,
      value: rewritePayload(options.payload, used),
      uploaded,
      reused: collected.value.size - uploaded,
    };
  } finally {
    release();
  }
}
