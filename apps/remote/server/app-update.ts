import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const APP_UPDATE_DIRECTORY = "/var/lib/pi-remote/app-updates";
export interface AppRelease {
  revision: string;
  versionCode: number;
  applicationId: "works.kenan.piremote.kenan";
  sha256: string;
  size: number;
  fileName: string;
}

export function isAppRelease(value: unknown): value is AppRelease {
  if (!value || typeof value !== "object") return false;
  const release = value as AppRelease;
  return /^[a-f0-9]{40}$/.test(release.revision)
    && Number.isSafeInteger(release.versionCode) && release.versionCode > 97 && release.versionCode <= 2_100_000_000
    && release.applicationId === "works.kenan.piremote.kenan"
    && /^[a-f0-9]{64}$/.test(release.sha256)
    && Number.isSafeInteger(release.size) && release.size > 0 && release.size <= 100 * 1024 * 1024
    && release.fileName === `${release.revision}.apk`;
}

type ReleaseResult = { ok: true; release: AppRelease | null } | { ok: false; error: string };
async function readRelease(directory: string): Promise<ReleaseResult> {
  try {
    const release: unknown = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
    return isAppRelease(release) ? { ok: true, release } : { ok: false, error: "The app update manifest is invalid." };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, release: null };
    return { ok: false, error: "The app update manifest could not be read." };
  }
}

export async function appUpdateResponse(request: Request, root = process.env.PI_REMOTE_APP_UPDATES_DIR || APP_UPDATE_DIRECTORY): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== "/v1/app-update" && !path.startsWith("/v1/app-update/")) return null;
  if (!["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  const match = /^\/v1\/app-update\/([a-f0-9]{40})\.apk$/.exec(path);
  if (path !== "/v1/app-update" && !match) return new Response(null, { status: 404 });
  const directory = join(root, match ? `releases/${match[1]}` : "current");
  const result = await readRelease(directory);
  if (!result.ok) return Response.json({ error: result.error }, { status: 503, headers: { "cache-control": "no-store" } });
  const release = result.release;
  if (!match) return Response.json({ release }, { headers: { "cache-control": "no-store" } });
  if (!release || release.revision !== match[1]) return new Response(null, { status: 404 });
  const file = Bun.file(join(directory, release.fileName));
  if (!await file.exists() || file.size !== release.size) return Response.json({ error: "The app update package is unavailable." }, { status: 503 });
  return new Response(request.method === "HEAD" ? null : file, { headers: {
    "content-type": "application/vnd.android.package-archive",
    "content-length": String(release.size),
    "content-disposition": `attachment; filename="${release.fileName}"`,
    "cache-control": "private, max-age=31536000, immutable",
    etag: `"${release.sha256}"`,
  } });
}
