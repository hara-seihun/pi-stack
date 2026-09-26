// Files a client may read from this host: the web client itself, the vendor
// assets, a directory listing for the Files drawer, and downloads of absolute
// paths with range support. Nothing here knows about sessions.
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { API_CORS_HEADERS } from "./cors";
import { sha256 } from "./sync";

import type { FileBrowserEntry } from "./protocol";

export function fileBrowserError(cause: any): { message: string; status: number } {
  if (cause?.code === "EACCES" || cause?.code === "EPERM") return { message: "Permission denied", status: 403 };
  if (cause?.code === "ENOENT" || cause?.code === "ENOTDIR") return { message: "Folder not found", status: 404 };
  return { message: cause?.message ?? "Could not read folder", status: 500 };
}

export function inspectPath(requested: string): FileBrowserEntry {
  if (!isAbsolute(requested)) throw Object.assign(new Error("Valid absolute path required"), { code: "EINVAL" });
  const path = resolve(requested);
  const stat = statSync(path);
  return { path, name: basename(path) || "/", kind: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other" };
}

export function listDirectory(requested: string) {
  if (!isAbsolute(requested)) throw Object.assign(new Error("Valid absolute folder path required"), { code: "EINVAL" });
  const path = resolve(requested);
  const entries: FileBrowserEntry[] = readdirSync(path, { withFileTypes: true }).map((entry) => {
    const child = join(path, entry.name);
    let kind: FileBrowserEntry["kind"] = entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other";
    if (entry.isSymbolicLink()) {
      try {
        const target = statSync(child);
        kind = target.isDirectory() ? "directory" : target.isFile() ? "file" : "other";
      } catch {}
    }
    return { name: entry.name, path: child, kind };
  });
  const rank = { directory: 0, file: 1, other: 2 } as const;
  entries.sort((left, right) => rank[left.kind] - rank[right.kind]
    || left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }));
  return { path, parent: path === "/" ? null : dirname(path), entries };
}

// Bun names several media types by their old `x-` spellings; a media element
// in Firefox or Safari may refuse those, so the standard names win.
const MEDIA_TYPES: Record<string, string> = {
  aac: "audio/aac", flac: "audio/flac", m4a: "audio/mp4", oga: "audio/ogg", opus: "audio/ogg", wav: "audio/wav", weba: "audio/webm",
  m4v: "video/mp4", mkv: "video/x-matroska", ogv: "video/ogg",
};

export function fileContentType(path: string, detected = ""): string {
  const extension = basename(path).toLowerCase().split(".").at(-1) ?? "";
  return MEDIA_TYPES[extension] ?? (detected || "application/octet-stream");
}

/**
 * Types a client may display in place rather than download. Scriptable
 * documents (HTML, SVG, XML) are absent: served inline from this origin they
 * would run with the reader's session.
 */
export function inlineSafe(contentType: string): boolean {
  const type = contentType.toLowerCase().split(";", 1)[0].trim();
  return type === "application/pdf" || type.startsWith("audio/") || type.startsWith("video/")
    || /^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(type);
}

export interface FileResponseOptions {
  /** File name offered to the reader; defaults to the path's base name. */
  name?: string;
  contentType: string;
  /** `inline` is honored only for `inlineSafe` types. */
  disposition?: "inline" | "attachment";
  cacheControl?: string;
  etag?: string;
}

function fileHeaders(path: string, size: number, options: FileResponseOptions): Headers {
  const name = options.name || basename(path) || "download";
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, "_") || "download";
  const encoded = encodeURIComponent(name).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  const disposition = options.disposition === "inline" && inlineSafe(options.contentType) ? "inline" : "attachment";
  const headers = new Headers({
    "content-type": options.contentType || "application/octet-stream",
    "content-length": String(size),
    "content-disposition": `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`,
    "cache-control": options.cacheControl ?? "private, no-cache",
    "accept-ranges": "bytes",
    "x-content-type-options": "nosniff",
    ...API_CORS_HEADERS,
  });
  if (options.etag) headers.set("etag", options.etag);
  return headers;
}

export function byteRange(value: string | null, size: number): { start: number; end: number } | null {
  if (!value) return null;
  const match = value.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2])) return null;
  // `bytes=-N` asks for the last N bytes; Safari's media stack uses it.
  if (!match[1]) {
    const length = Math.min(size, Number(match[2]));
    return Number.isSafeInteger(length) && length > 0 ? { start: size - length, end: size - 1 } : null;
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start <= end && start < size
    ? { start, end }
    : null;
}

/** A regular file with range support, so media can seek and stream. The caller has resolved and authorized `path`. */
export function servedFileResponse(path: string, method: string, req: Request, options: FileResponseOptions): Response {
  const size = statSync(path).size;
  const file = Bun.file(path);
  const headers = fileHeaders(path, size, options);
  if (method === "GET" && !req.headers.has("range") && options.etag && req.headers.get("if-none-match") === options.etag)
    return new Response(null, { status: 304, headers });
  const ranged = method === "GET" && req.headers.has("range") && (!req.headers.has("if-range") || !options.etag || req.headers.get("if-range") === options.etag);
  const range = ranged ? byteRange(req.headers.get("range"), size) : null;
  if (ranged && !range)
    return new Response(null, { status: 416, headers: { ...API_CORS_HEADERS, "content-range": `bytes */${size}` } });
  if (!range) return new Response(method === "HEAD" ? null : file, { headers });
  headers.set("content-range", `bytes ${range.start}-${range.end}/${size}`);
  headers.set("content-length", String(range.end - range.start + 1));
  return new Response(file.slice(range.start, range.end + 1), { status: 206, headers });
}

/** An absolute path on this host. `inline=1` in the request asks to display a safe type in place. */
export function localFileResponse(requested: string, method: string, req: Request): Response {
  if (!isAbsolute(requested)) return new Response("Valid absolute file path required", { status: 400, headers: API_CORS_HEADERS });
  try {
    const path = realpathSync(requested);
    const stat = statSync(path);
    if (!stat.isFile()) return new Response("File not found", { status: 404, headers: API_CORS_HEADERS });
    const inline = new URL(req.url, "http://localhost").searchParams.get("inline") === "1";
    return servedFileResponse(path, method, req, {
      contentType: fileContentType(path, Bun.file(path).type),
      disposition: inline ? "inline" : "attachment",
      etag: `"${sha256(`${path}:${stat.size}:${stat.mtimeMs}`)}"`,
    });
  } catch { return new Response("File not found", { status: 404, headers: API_CORS_HEADERS }); }
}

const WEB_CSP = "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self' blob:; object-src 'none'; frame-ancestors 'none'";

/** Content-hashed build output: the name changes whenever the bytes do, so it can be cached forever. */
const IMMUTABLE = /^assets\//;

/** Twins written by `compress-dist.mjs`; a client asking for one directly gets nothing. */
const TWIN = /\.(?:br|gz)$/;

function acceptsEncoding(header: string | null, encoding: string): boolean {
  if (!header) return false;
  for (const part of header.split(",")) {
    const [name, ...parameters] = part.trim().split(";");
    if (name !== encoding && name !== "*") continue;
    const quality = parameters.map((value) => value.trim()).find((value) => value.startsWith("q="));
    if (quality && Number(quality.slice(2)) === 0) return false;
    return true;
  }
  return false;
}

/**
 * Serves the built client and its public assets. Hashed files under `assets/`
 * are immutable for a year; everything else revalidates against a strong ETag,
 * so a repeat visit costs one 304 instead of the whole page. When the build has
 * written a `.br` or `.gz` twin and the client accepts it, the twin is sent in
 * place of the original.
 */
export function webResponse(webDir: string, pathname: string, method: string, req?: Request): Response | null {
  if (method !== "GET" && method !== "HEAD") return null;
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  if (!relative || TWIN.test(relative) || relative.split("/").some((part) => !part || part === "." || part === "..")) return null;
  const file = join(webDir, relative);
  if (!existsSync(file)) return null;
  const stat = statSync(file);
  if (!stat.isFile()) return null;

  const immutable = IMMUTABLE.test(relative);
  const accept = req?.headers.get("accept-encoding") ?? null;
  let encoding = "";
  let body = file;
  for (const candidate of ["br", "gzip"] as const) {
    const twin = `${file}.${candidate === "gzip" ? "gz" : candidate}`;
    if (!acceptsEncoding(accept, candidate) || !existsSync(twin)) continue;
    encoding = candidate;
    body = twin;
    break;
  }

  const asset = Bun.file(file);
  const headers = new Headers({
    "content-type": asset.type || "application/octet-stream",
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    vary: "accept-encoding",
    "x-content-type-options": "nosniff",
    "content-security-policy": WEB_CSP,
  });
  if (encoding) headers.set("content-encoding", encoding);
  if (!immutable) {
    // Size and mtime identify the build output; each encoding is its own representation.
    const etag = `"${sha256(`${relative}:${stat.size}:${stat.mtimeMs}`)}${encoding ? `-${encoding}` : ""}"`;
    headers.set("etag", etag);
    const known = req?.headers.get("if-none-match");
    if (known && known.split(",").some((value) => value.trim() === etag || value.trim() === "*"))
      return new Response(null, { status: 304, headers });
  }
  return new Response(method === "HEAD" ? null : Bun.file(body), { headers });
}
