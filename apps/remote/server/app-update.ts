import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const APP_UPDATE_DIRECTORY = "/var/lib/pi-remote/app-updates";
export const APPLICATION_ID = "works.kenan.piremote.kenan";
export const MAX_APK_BYTES = 100 * 1024 * 1024;
export const MAX_WEB_BUNDLE_BYTES = 50 * 1024 * 1024;

/** The Android package. `shellId` identifies its native inputs; publications before it carried none. */
export interface AppRelease {
  revision: string;
  versionCode: number;
  applicationId: typeof APPLICATION_ID;
  sha256: string;
  size: number;
  fileName: string;
  shellId?: string;
}

/** The shared web client alone, applied in place by any installed app with the same `shellId`. */
export interface WebRelease {
  revision: string;
  versionCode: number;
  applicationId: typeof APPLICATION_ID;
  shellId: string;
  sha256: string;
  size: number;
  fileName: string;
}

export const isShellId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{16}$/.test(value);

function isReleaseBase(value: unknown, maximumSize: number): value is AppRelease {
  if (!value || typeof value !== "object") return false;
  const release = value as AppRelease;
  return /^[a-f0-9]{40}$/.test(release.revision)
    && Number.isSafeInteger(release.versionCode) && release.versionCode > 97 && release.versionCode <= 2_100_000_000
    && release.applicationId === APPLICATION_ID
    && /^[a-f0-9]{64}$/.test(release.sha256)
    && Number.isSafeInteger(release.size) && release.size > 0 && release.size <= maximumSize;
}

export function isAppRelease(value: unknown): value is AppRelease {
  return isReleaseBase(value, MAX_APK_BYTES)
    && value.fileName === `${value.revision}.apk`
    && (value.shellId === undefined || isShellId(value.shellId));
}

export function isWebRelease(value: unknown): value is WebRelease {
  return isReleaseBase(value, MAX_WEB_BUNDLE_BYTES)
    && value.fileName === `${value.revision}.web.zip`
    && isShellId(value.shellId);
}

type ReleaseResult<T> = { ok: true; release: T | null } | { ok: false; error: string };
async function readManifest<T>(path: string, valid: (value: unknown) => value is T, label: string): Promise<ReleaseResult<T>> {
  try {
    const release: unknown = JSON.parse(await readFile(path, "utf8"));
    return valid(release) ? { ok: true, release } : { ok: false, error: `The ${label} manifest is invalid.` };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, release: null };
    return { ok: false, error: `The ${label} manifest could not be read.` };
  }
}

export const readAppRelease = (directory: string) => readManifest(join(directory, "manifest.json"), isAppRelease, "app update");
export const readWebRelease = (directory: string) => readManifest(join(directory, "web-manifest.json"), isWebRelease, "web update");

async function fileResponse(request: Request, path: string, release: { size: number; sha256: string; fileName: string }, contentType: string) {
  const file = Bun.file(path);
  if (!await file.exists() || file.size !== release.size) return Response.json({ error: "The app update package is unavailable." }, { status: 503 });
  return new Response(request.method === "HEAD" ? null : file, { headers: {
    "content-type": contentType,
    "content-length": String(release.size),
    "content-disposition": `attachment; filename="${release.fileName}"`,
    "cache-control": "private, max-age=31536000, immutable",
    etag: `"${release.sha256}"`,
  } });
}

export async function appUpdateResponse(request: Request, root = process.env.PI_REMOTE_APP_UPDATES_DIR || APP_UPDATE_DIRECTORY): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== "/v1/app-update" && !path.startsWith("/v1/app-update/")) return null;
  if (!["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  const match = /^\/v1\/app-update\/([a-f0-9]{40})\.(apk|web\.zip)$/.exec(path);
  if (path !== "/v1/app-update" && !match) return new Response(null, { status: 404 });
  const directory = join(root, match ? `releases/${match[1]}` : "current");
  const noStore = { "cache-control": "no-store" };
  if (!match) {
    const [apk, web] = await Promise.all([readAppRelease(directory), readWebRelease(directory)]);
    if (!apk.ok) return Response.json({ error: apk.error }, { status: 503, headers: noStore });
    if (!web.ok) return Response.json({ error: web.error }, { status: 503, headers: noStore });
    return Response.json({ release: apk.release, web: web.release }, { headers: noStore });
  }
  if (match[2] === "apk") {
    const result = await readAppRelease(directory);
    if (!result.ok) return Response.json({ error: result.error }, { status: 503, headers: noStore });
    if (!result.release || result.release.revision !== match[1]) return new Response(null, { status: 404 });
    return fileResponse(request, join(directory, result.release.fileName), result.release, "application/vnd.android.package-archive");
  }
  const result = await readWebRelease(directory);
  if (!result.ok) return Response.json({ error: result.error }, { status: 503, headers: noStore });
  if (!result.release || result.release.revision !== match[1]) return new Response(null, { status: 404 });
  return fileResponse(request, join(directory, result.release.fileName), result.release, "application/zip");
}
