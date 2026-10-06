import { appStorageKey } from "./app-path";
import type { IdleNotificationFeed } from "../../server/protocol";
import { nativePlatform, nativeSessionReady, remote } from "./native";

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

type IdleSink = (feed: IdleNotificationFeed, replay: boolean, after: number | null) => void;
let idleSink: IdleSink | null = null;
let activitySink: ((healthy: boolean) => void) | null = null;
let replayOrigin: { user: string; session: string; environment: string; after: number | null } | null = null;
let replayRecoveryPending = false;
let pending: { user: string; session: string; feed: IdleNotificationFeed; replay: boolean; after: number | null } | null = null;

export async function notificationReplayCursor(user: string, environment: string): Promise<number | null> {
  const session = window.PiRemotePerson.session();
  let after: number | null;
  if (nativePlatform) {
    await nativeSessionReady();
    after = (await remote.notificationCursor!({ user, session, environment })).after;
  } else {
    const stored = localStorage.getItem(cursorKey(user, environment));
    after = stored === null ? null : readIdleCursor(user, environment);
  }
  if (user !== window.PiRemotePerson.get() || session !== window.PiRemotePerson.session()) throw new DOMException("Notification identity changed", "AbortError");
  replayOrigin = { user, session, environment, after };
  replayRecoveryPending = false;
  pending = null;
  return after;
}

export function notificationFeedActivity(healthy: boolean) { activitySink?.(healthy); }

export function requireNotificationReplay(user: string, session: string, environment: string) {
  if (replayRecoveryPending) return;
  replayRecoveryPending = true;
  window.dispatchEvent(new CustomEvent("pi-notification-replay-required", { detail: { user, session, environment } }));
}

export function deliverIdleNotifications(feed: IdleNotificationFeed, replay = true) {
  const origin = replayOrigin;
  const after = origin?.user === window.PiRemotePerson.get() && origin.session === window.PiRemotePerson.session() ? origin.after : null;
  if (idleSink) { idleSink(feed, replay, after); return; }
  const user = window.PiRemotePerson.get();
  const session = window.PiRemotePerson.session();
  const previous = pending?.user === user && pending.session === session ? pending.feed : null;
  pending = { user, session, replay: replay && (!pending || pending.replay), after, feed: {
    cursor: Math.max(previous?.cursor ?? 0, feed.cursor),
    notifications: [...new Map([...(previous?.notifications ?? []), ...feed.notifications].map(item => [item.seq, item])).values()],
  } };
}

export function setIdleSink(sink: IdleSink, activity?: (healthy: boolean) => void) {
  idleSink = sink;
  activitySink = activity ?? null;
  const buffered = pending;
  pending = null;
  if (buffered?.user === window.PiRemotePerson.get() && buffered.session === window.PiRemotePerson.session()) sink(buffered.feed, buffered.replay, buffered.after);
  return () => { if (idleSink === sink) { idleSink = null; activitySink = null; } };
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
