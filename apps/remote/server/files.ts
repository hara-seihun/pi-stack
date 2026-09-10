// Files a client may read from this host: the web client itself, the vendor
// assets, a directory listing for the Files drawer, and downloads of absolute
// paths with range support. Nothing here knows about sessions.
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { API_CORS_HEADERS } from "./cors";
import { sha256 } from "./sync";

export type FileBrowserEntry = { name: string; path: string; kind: "directory" | "file" | "other" };

export function fileBrowserError(cause: any): { message: string; status: number } {
  if (cause?.code === "EACCES" || cause?.code === "EPERM") return { message: "Permission denied", status: 403 };
  if (cause?.code === "ENOENT" || cause?.code === "ENOTDIR") return { message: "Folder not found", status: 404 };
  return { message: cause?.message ?? "Could not read folder", status: 500 };
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

export function webResponse(webDir: string, pathname: string, method: string): Response | null {
  if (method !== "GET" && method !== "HEAD") return null;
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  if (!relative || relative.split("/").some((part) => !part || part === "." || part === "..")) return null;
  const file = join(webDir, relative);
  if (!existsSync(file) || !statSync(file).isFile()) return null;
  const asset = Bun.file(file);
  return new Response(method === "HEAD" ? null : asset, {
    headers: {
      "content-type": asset.type || "application/octet-stream",
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self' blob:; object-src 'none'; frame-ancestors 'none'",
    },
  });
}
