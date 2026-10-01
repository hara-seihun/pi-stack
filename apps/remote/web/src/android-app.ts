import { appPath } from "./app-path";

export function offerAndroidApp(userAgent: string, native: boolean, dismissed: boolean): boolean {
  return !native && !dismissed && /Android.*Mobile/i.test(userAgent);
}

export function androidDownloadUrl(manifest: unknown, href = location.href): string {
  const file = (manifest as { release?: { fileName?: unknown } })?.release?.fileName;
  if (typeof file !== "string" || !/^[A-Za-z0-9._-]+\.apk$/.test(file)) throw new Error("The Android download is not available yet.");
  return appPath(`v1/app-update/${encodeURIComponent(file)}`, href);
}
