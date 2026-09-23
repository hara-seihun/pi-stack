import { appStorageKey } from "./app-path";
import type { IdleNotificationFeed } from "../../server/protocol";
import { nativePlatform, remote } from "./native";

export interface NotificationTarget { environment?: string; sessionId?: string; user?: string }
const targetKey = () => appStorageKey("pi-notification-target");

// Idle-notification cursors and the target a notification opened. The
// permission surface and the poll of other environments live with the Machine
// screen in `notification-control.tsx`; this module is what the app itself
// needs, so it stays in the first paint.
export const cursorKey = (user: string, environment: string) => appStorageKey(`pi-idle-cursor:${user}:${environment}`);

export function readIdleCursor(user: string, environment: string): number {
  try { return Number(localStorage.getItem(cursorKey(user, environment))) || 0; } catch { return 0; }
}

export function saveIdleCursor(user: string, environment: string, cursor: number) {
  try { localStorage.setItem(cursorKey(user, environment), String(cursor)); } catch {}
}

type IdleSink = (feed: IdleNotificationFeed) => void;
let idleSink: IdleSink | null = null;

/** The stream hands the current environment's feed to whoever can show it. */
export function deliverIdleNotifications(feed: IdleNotificationFeed) {
  idleSink?.(feed);
}

/** The Machine screen's notification control claims the feed while it is mounted. */
export function setIdleSink(sink: IdleSink | null) {
  idleSink = sink;
  return () => { if (idleSink === sink) idleSink = null; };
}

export async function takeNotificationTarget(): Promise<NotificationTarget | null> {
  const saved = sessionStorage.getItem(targetKey());
  if (saved) { sessionStorage.removeItem(targetKey()); return JSON.parse(saved); }
  if (nativePlatform) return await remote.notificationTarget?.() ?? null;
  const url = new URL(location.href);
  if (!url.searchParams.has("idleSession")) return null;
  const target = { environment: url.searchParams.get("environment") || "", sessionId: url.searchParams.get("idleSession") || "", user: url.searchParams.get("user") || "" };
  for (const key of ["environment", "idleSession", "user"]) url.searchParams.delete(key);
  history.replaceState(null, "", url);
  return target;
}

export function retainNotificationTarget(target: NotificationTarget) {
  sessionStorage.setItem(targetKey(), JSON.stringify(target));
}
