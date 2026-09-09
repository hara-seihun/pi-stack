import { useEffect, useState } from "react";
import { API } from "../../server/api";
import type { IdleNotificationFeed } from "../../server/notifications";
import { browserFetch, loadBrowserEnvironments, nativePlatform, remote } from "./native";

export interface NotificationTarget { environment?: string; sessionId?: string; user?: string }
const TARGET = "pi-notification-target";

export async function takeNotificationTarget(): Promise<NotificationTarget | null> {
  const saved = sessionStorage.getItem(TARGET);
  if (saved) { sessionStorage.removeItem(TARGET); return JSON.parse(saved); }
  if (nativePlatform) return await remote.notificationTarget?.() ?? null;
  const url = new URL(location.href);
  if (!url.searchParams.has("idleSession")) return null;
  const target = { environment: url.searchParams.get("environment") || "", sessionId: url.searchParams.get("idleSession") || "", user: url.searchParams.get("user") || "" };
  for (const key of ["environment", "idleSession", "user"]) url.searchParams.delete(key);
  history.replaceState(null, "", url);
  return target;
}

export function retainNotificationTarget(target: NotificationTarget) {
  sessionStorage.setItem(TARGET, JSON.stringify(target));
}

export function NotificationControl() {
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState("");
  const [user, setUser] = useState(window.PiRemotePerson?.get() || "");
  useEffect(() => {
    const changed = () => setUser(window.PiRemotePerson?.get() || "");
    window.addEventListener("pi-person", changed);
    return () => window.removeEventListener("pi-person", changed);
  }, []);
  const configure = async (request: boolean) => {
    try {
      if (nativePlatform) setEnabled((await remote.notifications!({ user, request })).enabled);
      else if ("Notification" in window) setEnabled((request ? await Notification.requestPermission() : Notification.permission) === "granted");
      else throw new Error("This browser does not support notifications");
      setError("");
    } catch (cause) { setError(String(cause)); }
  };
  useEffect(() => { void configure(false); }, [user]);
  useEffect(() => {
    if (nativePlatform || !enabled) return;
    const controller = new AbortController();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const failures = new Map<string, string>();
    const poll = async (environment: { id: string; name: string; baseUrl: string }) => {
      const key = `pi-idle-cursor:${user}:${environment.id}`;
      try {
        await navigator.locks.request(key, { signal: controller.signal }, async () => {
        const stored = localStorage.getItem(key);
        const response = await browserFetch(`${environment.baseUrl}${API.notifications.path({}, { after: stored })}`, {
          headers: user ? { "x-pi-remote-user": user } : {}, cache: "no-store",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
        });
        if (!response.ok) throw new Error(response.status === 423 ? "Locked. Open this environment to unlock." : `HTTP ${response.status}`);
        const feed = await response.json() as IdleNotificationFeed & { environmentId: string };
        if (feed.environmentId !== environment.id) throw new Error("Environment identity mismatch");
        controller.signal.throwIfAborted();
        for (const event of feed.notifications) {
          const notification = new Notification(`${environment.name} · ${event.name}`, {
            body: "Session is idle", tag: `${key}:${event.seq}`,
          });
          notification.onclick = () => {
            const url = new URL(location.href);
            url.searchParams.set("environment", environment.id);
            url.searchParams.set("idleSession", event.sessionId);
            url.searchParams.set("user", user);
            window.open(url, "_blank");
            notification.close();
          };
        }
        localStorage.setItem(key, String(feed.cursor));
        });
        failures.delete(environment.id);
      } catch (cause) {
        if (!controller.signal.aborted) failures.set(environment.id, `${environment.name}: ${String(cause)}`);
      }
      if (!controller.signal.aborted) {
        setError([...failures.values()].join(" · "));
        const timer = setTimeout(() => { timers.delete(timer); void poll(environment); }, 5_000);
        timers.add(timer);
      }
    };
    void loadBrowserEnvironments().then((environments) => {
      if (!controller.signal.aborted) for (const environment of environments) void poll(environment);
    }).catch((cause) => { if (!controller.signal.aborted) setError(String(cause)); });
    return () => { controller.abort(); for (const timer of timers) clearTimeout(timer); };
  }, [enabled, user]);
  return <div className="usage-summary" title={error || (nativePlatform ? "Monitors every environment, including in the background" : "Monitors every environment while this page is open")}>
    <button onClick={() => void configure(true)}>{enabled ? "Notifications on · all environments" : "Enable notifications"}</button>
    {error && <div role="status">{error}</div>}
  </div>;
}
