import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { API } from "../../server/api";
import type { IdleNotificationFeed } from "../../server/protocol";
import { browserFetch, loadEnvironments, nativePlatform, nativeSessionReady, remote } from "./native";
import { cursorKey, readIdleCursor, saveIdleCursor, setIdleSink, retainNotificationTarget, type NotificationTarget } from "./notifications";
import { ThreadNotifications, threadNotificationKey } from "./thread-notifications";
import { DismissibleError } from "./dismissible-error";
import { toast } from "./toasts";

const POLL_MS = 30_000;
const NotificationContext = createContext({ enabled: false, error: "", enable: () => {} });
type Environment = { id: string; name: string; baseUrl: string };
type ToastNotification = NotificationTarget & { title: string; seq: number };

function openNotification(target: NotificationTarget) {
  retainNotificationTarget(target);
  window.dispatchEvent(new Event("pi-notification"));
  window.focus();
}

export function NotificationProvider({ sessionId, children }: { sessionId: string | null; children: ReactNode }) {
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState("");
  const [identity, setIdentity] = useState(() => ({ user: window.PiRemotePerson.get(), session: window.PiRemotePerson.session() }));
  const { user, session } = identity;
  const [environment, setEnvironment] = useState<Environment | null>(null);
  const [browserNotifications, setBrowserNotifications] = useState<ThreadNotifications | null>(null);
  const toastKeys = useRef(new Set<string>());
  const selected = useRef({ sessionId, environment: environment?.id });
  selected.current = { sessionId, environment: environment?.id };

  const showToast = (key: string, title: string, open: () => void) => {
    toastKeys.current.add(key);
    toast(<button type="button" className="notification-toast" onClick={() => { toast.dismiss(key); toastKeys.current.delete(key); open(); }}>
      <strong>{title}</strong><span>Session is idle</span>
    </button>, { id: key, duration: 6000, onDismiss: () => toastKeys.current.delete(key), onAutoClose: () => toastKeys.current.delete(key) });
  };
  const clearToast = (key: string) => { toast.dismiss(key); toastKeys.current.delete(key); };

  useEffect(() => {
    const changed = () => setIdentity({ user: window.PiRemotePerson.get(), session: window.PiRemotePerson.session() });
    const failed = (event: Event) => setError((event as CustomEvent<string>).detail);
    window.addEventListener("pi-person", changed);
    window.addEventListener("pi-auth", changed);
    window.addEventListener("pi-native-auth-error", failed);
    return () => {
      window.removeEventListener("pi-person", changed);
      window.removeEventListener("pi-auth", changed);
      window.removeEventListener("pi-native-auth-error", failed);
    };
  }, []);

  // This owner stays mounted across tabs: permission controls are just a view of it.
  useEffect(() => {
    const clear = () => { for (const key of toastKeys.current) toast.dismiss(key); toastKeys.current.clear(); };
    if (nativePlatform) {
      const receive = (event: Event) => {
        const item = (event as CustomEvent<ToastNotification>).detail;
        if (item.user !== window.PiRemotePerson.get() || !window.PiRemotePerson.session()) return;
        if (!item.environment || !item.sessionId) return;
        const key = threadNotificationKey(item.user, item.environment, item.sessionId);
        if (document.visibilityState === "visible" && selected.current.environment === item.environment && selected.current.sessionId === item.sessionId) {
          clearToast(key);
          return;
        }
        showToast(key, item.title, () => openNotification(item));
      };
      window.addEventListener("pi-notification-toast", receive);
      return () => { window.removeEventListener("pi-notification-toast", receive); clear(); };
    }
    if (!("Notification" in window)) return clear;
    const notifications = new ThreadNotifications({ visible: () => document.visibilityState === "visible", show: showToast, clear: clearToast });
    setBrowserNotifications(notifications);
    return () => { notifications.dispose(); clear(); };
  }, [user, session]);

  const configure = async (request: boolean) => {
    try {
      if (!session) { setEnabled(false); return; }
      if (nativePlatform) {
        await nativeSessionReady();
        if (user !== window.PiRemotePerson.get() || session !== window.PiRemotePerson.session()) return;
        setEnabled((await remote.notifications!({ request })).enabled);
      } else if ("Notification" in window) {
        setEnabled((request ? await Notification.requestPermission() : Notification.permission) === "granted");
      } else if (request) throw new Error("This browser does not support notifications");
      setError("");
    } catch (cause) { setError(String(cause)); }
  };
  useEffect(() => {
    let active = true;
    setEnvironment(null);
    if (session) void window.KenanRemote!.getState().then(value => {
      if (active) setEnvironment({ id: value.id, name: value.name || value.id, baseUrl: value.baseUrl });
    }).catch(cause => { if (active) setError(String(cause)); });
    void configure(false);
    const refresh = () => { if (document.visibilityState === "visible") void configure(false); };
    document.addEventListener("visibilitychange", refresh);
    return () => { active = false; document.removeEventListener("visibilitychange", refresh); };
  }, [user, session]);

  useEffect(() => {
    if (!session || !environment) return;
    let disposed = false;
    let viewing: AbortController | null = null;
    const update = async () => {
      viewing?.abort();
      const controller = new AbortController();
      viewing = controller;
      try {
        const visibleThread = document.visibilityState === "visible" ? sessionId : null;
        if (visibleThread) clearToast(threadNotificationKey(user, environment.id, visibleThread));
        if (nativePlatform) {
          await nativeSessionReady();
          if (disposed || controller.signal.aborted) return;
          await remote.notificationThread!({ user, environment: environment.id, sessionId: visibleThread || "" });
        } else if (visibleThread) {
          await browserNotifications?.view(threadNotificationKey(user, environment.id, visibleThread), controller.signal);
        }
      } catch (cause) { if (!disposed && !controller.signal.aborted) setError(String(cause)); }
    };
    void update();
    document.addEventListener("visibilitychange", update);
    const hide = () => viewing?.abort();
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", update);
    return () => {
      disposed = true;
      viewing?.abort();
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", update);
    };
  }, [sessionId, user, session, environment, browserNotifications]);

  useEffect(() => {
    if (!session || !environment) return;
    let active = true;
    const current = () => active && user === window.PiRemotePerson.get() && session === window.PiRemotePerson.session();
    const deliver = async (source: Environment, feed: IdleNotificationFeed) => {
      if (!current()) return;
      if (nativePlatform) {
        await nativeSessionReady();
        if (current()) await remote.notificationFeed!({ user, environment: source.id, name: source.name, feed });
        return;
      }
      if (!enabled || !browserNotifications) return;
      for (const event of feed.notifications) {
        if (!current()) return;
        const key = threadNotificationKey(user, source.id, event.sessionId);
        if (source.id === environment.id && selected.current.sessionId === event.sessionId && document.visibilityState === "visible") {
          clearToast(key);
          continue;
        }
        await browserNotifications.show(key, `${source.name} · ${event.name}`, () => openNotification({ user, environment: source.id, sessionId: event.sessionId }));
      }
    };
    let streamDelivery = Promise.resolve();
    const stop = setIdleSink(feed => {
      streamDelivery = streamDelivery.then(async () => {
        if (nativePlatform) {
          await deliver(environment, feed);
          if (current()) saveIdleCursor(user, environment.id, Math.max(readIdleCursor(user, environment.id), feed.cursor));
        } else {
          await navigator.locks.request(cursorKey(user, environment.id), async () => {
            if (!current()) return;
            const after = readIdleCursor(user, environment.id);
            await deliver(environment, { ...feed, notifications: feed.notifications.filter(event => event.seq > after) });
            if (current()) saveIdleCursor(user, environment.id, Math.max(after, feed.cursor));
          });
        }
      }).catch(cause => { if (current()) setError(String(cause)); });
    });
    const controller = new AbortController();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const failures = new Map<string, string>();
    const poll = async (source: Environment) => {
      try {
        await navigator.locks.request(cursorKey(user, source.id), { signal: controller.signal }, async () => {
          const stored = localStorage.getItem(cursorKey(user, source.id));
          const response = await browserFetch(`${source.baseUrl}${API.notifications.path({}, { after: stored })}`, {
            headers: { "x-pi-remote-user": user, "x-pi-remote-session": session }, cache: "no-store", redirect: "error",
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
          });
          if (response.status === 423) {
            window.PiRemotePerson.clearSession(session);
            controller.abort();
            throw new Error("Locked. Unlock your folder to resume notifications.");
          }
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const feed = await response.json() as IdleNotificationFeed & { environmentId: string };
          if (feed.environmentId !== source.id) throw new Error("Environment identity mismatch");
          controller.signal.throwIfAborted();
          if (!current()) return;
          // The stream and other tabs share this cursor; never replay a settled page.
          const after = readIdleCursor(user, source.id);
          await deliver(source, { ...feed, notifications: feed.notifications.filter(event => event.seq > after) });
          if (current()) saveIdleCursor(user, source.id, Math.max(after, feed.cursor));
        });
        failures.delete(source.id);
      } catch (cause) {
        if (!controller.signal.aborted) failures.set(source.id, `${source.name}: ${String(cause)}`);
      }
      if (!controller.signal.aborted) {
        setError([...failures.values()].join(" · "));
        const timer = setTimeout(() => { timers.delete(timer); void poll(source); }, POLL_MS);
        timers.add(timer);
      }
    };
    if (!nativePlatform && enabled && browserNotifications) void loadEnvironments().then(sources => {
      if (!controller.signal.aborted) for (const source of sources) if (source.id !== environment.id) void poll(source);
    }).catch(cause => { if (current()) setError(String(cause)); });
    return () => { active = false; stop(); controller.abort(); for (const timer of timers) clearTimeout(timer); };
  }, [nativePlatform ? true : enabled, user, session, browserNotifications, environment]);

  return <NotificationContext.Provider value={{ enabled, error, enable: () => void configure(true) }}>{children}</NotificationContext.Provider>;
}

export function NotificationControl() {
  const { enabled, error, enable } = useContext(NotificationContext);
  return <div className="notification-control" title={nativePlatform ? "Monitors allowed environments, including in the background" : "Monitors allowed environments while this page is open"}>
    {enabled ? <p className="muted">Notifications are on for every environment you can reach.</p> : <button type="button" onClick={enable}>Enable notifications</button>}
    <DismissibleError message={error} role="status" dismissLabel="Dismiss notification error" />
  </div>;
}
