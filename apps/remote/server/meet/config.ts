import { existsSync, readFileSync } from "node:fs";
import type { MeetIceServer } from "./protocol";

export function meetIceServers(hostFile = process.env.PI_STACK_HOST_FILE ?? "/etc/pi-stack/host.json"): MeetIceServer[] {
  if (!existsSync(hostFile)) return [];
  const entries = JSON.parse(readFileSync(hostFile, "utf8")).meetIceServers ?? [];
  if (!Array.isArray(entries) || entries.some((entry) => !entry || !Array.isArray(entry.urls)
    || !entry.urls.length || entry.urls.some((url: unknown) => typeof url !== "string" || !/^turns?:/.test(url))
    || typeof entry.username !== "string" || typeof entry.credential !== "string")) {
    throw new Error(`${hostFile}: meetIceServers must contain TURN URLs, username and credential`);
  }
  return entries;
}
