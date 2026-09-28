import { appStorageKey } from "./app-path";
import type { IdleNotificationFeed } from "../../server/protocol";
import { nativePlatform, remote } from "./native";

export interface NotificationTarget { environment?: string; sessionId?: string; user?: string }
const targetKey = () => appStorageKey("pi-notification-target");

// The app-wide notification owner consumes stream feeds and opens their targets.
export const cursorKey = (user: string, environment: string) => appStorageKey(`pi-idle-cursor:${user}:${environment}`);

export function readIdleCursor(user: string, environment: string): number {
  try { return Number(localStorage.getItem(cursorKey(user, environment))) || 0; } catch { return 0; }
}

export function saveIdleCursor(user: string, environment: string, cursor: number) {
  try { localStorage.setItem(cursorKey(user, environment), String(cursor)); } catch {}
}

type IdleSink = (feed: IdleNotificationFeed) => void;
let idleSink: IdleSink | null = null;
let pending: { user: string; session: string; feed: IdleNotificationFeed } | null = null;

export function deliverIdleNotifications(feed: IdleNotificationFeed) {
  if (idleSink) { idleSink(feed); return; }
  const user = window.PiRemotePerson.get();
  const session = window.PiRemotePerson.session();
  const previous = pending?.user === user && pending.session === session ? pending.feed : null;
  pending = { user, session, feed: {
    cursor: Math.max(previous?.cursor ?? 0, feed.cursor),
    notifications: [...new Map([...(previous?.notifications ?? []), ...feed.notifications].map(item => [item.seq, item])).values()],
  } };
}

export function setIdleSink(sink: IdleSink) {
  idleSink = sink;
  const buffered = pending;
  pending = null;
  if (buffered?.user === window.PiRemotePerson.get() && buffered.session === window.PiRemotePerson.session()) sink(buffered.feed);
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
