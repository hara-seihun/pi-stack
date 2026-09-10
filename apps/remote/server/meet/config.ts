import { existsSync, readFileSync } from "node:fs";
import type { MeetIceServer } from "./protocol";

export function meetIceServers(hostFile = process.env.PI_STACK_MEET_FILE ?? "/etc/pi-stack/meet.json"): MeetIceServer[] {
  if (!existsSync(hostFile)) return [];
  const entries = JSON.parse(readFileSync(hostFile, "utf8")).iceServers ?? [];
  if (!Array.isArray(entries) || entries.some((entry) => !entry || !Array.isArray(entry.urls)
    || !entry.urls.length || entry.urls.some((url: unknown) => typeof url !== "string" || !/^turns?:/.test(url))
    || typeof entry.username !== "string" || typeof entry.credential !== "string")) {
    throw new Error(`${hostFile}: iceServers must contain TURN URLs, username and credential`);
  }
  return entries;
}
