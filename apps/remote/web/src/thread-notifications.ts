import { appPath, appStorageKey } from "./app-path";

export function threadNotificationKey(user: string, environment: string, session: string) {
  return appStorageKey(`pi-visible-thread:${JSON.stringify([user, environment, session])}`);
}

export class ThreadNotifications {
  private notifications = new Map<string, Notification>();
  private disposed = false;
  private channel = new BroadcastChannel(appStorageKey("pi-thread-notifications"));

  constructor() {
    this.channel.onmessage = (event) => {
      if (typeof event.data === "string") this.clear(event.data);
    };
  }

  private clear(key: string) {
    this.notifications.get(key)?.close();
    this.notifications.delete(key);
  }

  async view(key: string, signal: AbortSignal) {
    await navigator.locks.request(key, { mode: "shared", signal }, async () => {
      this.clear(key);
      this.channel.postMessage(key);
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    });
  }

  async show(key: string, title: string, onClick: () => void) {
    await navigator.locks.request(key, { ifAvailable: true }, (lock) => {
      if (!lock || this.disposed) return;
      this.clear(key);
      const notification = new Notification(title, { body: "Session is idle", tag: key, icon: appPath("kenan.png") });
      this.notifications.set(key, notification);
      notification.onclick = () => { onClick(); this.clear(key); };
      notification.onclose = () => {
        if (this.notifications.get(key) === notification) this.notifications.delete(key);
      };
    });
  }

  dispose() {
    this.disposed = true;
    this.channel.close();
    for (const key of this.notifications.keys()) this.clear(key);
  }
}
