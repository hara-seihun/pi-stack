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

function downloadHeaders(path: string, size: number, contentType: string, etagValue = `${size}`): Headers {
  const name = basename(path) || "download";
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, "_") || "download";
  const encoded = encodeURIComponent(name).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return new Headers({
    "content-type": contentType || "application/octet-stream",
    "content-length": String(size),
    "content-disposition": `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`,
    "cache-control": "private, no-cache",
    "accept-ranges": "bytes",
    etag: `\"${sha256(`${path}:${etagValue}`)}\"`,
    "x-content-type-options": "nosniff",
    ...API_CORS_HEADERS,
  });
}

export function byteRange(value: string | null, size: number): { start: number; end: number } | null {
  if (!value) return null;
  const match = value.match(/^bytes=(\d+)-(\d*)$/);
  if (!match) return null;
  const start = Number(match[1]);
  const end = match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start <= end && start < size
    ? { start, end }
    : null;
}

export function localFileResponse(requested: string, method: string, req: Request): Response {
  if (!isAbsolute(requested)) return new Response("Valid absolute file path required", { status: 400, headers: API_CORS_HEADERS });
  try {
    const path = realpathSync(requested);
    const stat = statSync(path);
    if (!stat.isFile()) return new Response("File not found", { status: 404, headers: API_CORS_HEADERS });
    const file = Bun.file(path);
    const headers = downloadHeaders(path, stat.size, file.type, `${stat.size}:${stat.mtimeMs}`);
    const range = method === "GET" ? byteRange(req.headers.get("range"), stat.size) : null;
    if (req.headers.has("range") && method === "GET" && !range)
      return new Response(null, { status: 416, headers: { ...API_CORS_HEADERS, "content-range": `bytes */${stat.size}` } });
    if (!range) return new Response(method === "HEAD" ? null : file, { headers });
    headers.set("content-range", `bytes ${range.start}-${range.end}/${stat.size}`);
    headers.set("content-length", String(range.end - range.start + 1));
    return new Response(file.slice(range.start, range.end + 1), { status: 206, headers });
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
