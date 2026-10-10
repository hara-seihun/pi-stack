import { appPath, appStorageKey } from "./app-path";

export function threadNotificationKey(user: string, environment: string, session: string) {
  return appStorageKey(`pi-visible-thread:${JSON.stringify([user, environment, session])}`);
}

export class ThreadNotifications {
  private notifications = new Map<string, Notification>();
  private disposed = false;
  private channel = new BroadcastChannel(appStorageKey("pi-thread-notifications"));

  constructor(private foreground?: { visible(): boolean; show(key: string, title: string, open: () => void, body: string): void; clear(key: string): void }) {
    this.channel.onmessage = (event) => {
      if (typeof event.data === "string") this.clear(event.data);
    };
  }

  private clear(key: string) {
    this.notifications.get(key)?.close();
    this.notifications.delete(key);
    this.foreground?.clear(key);
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

  async show(key: string, title: string, onClick: () => void, body = "Session is idle", important = false) {
    await navigator.locks.request(key, { ifAvailable: true }, (lock) => {
      if (!lock || this.disposed) return;
      this.clear(key);
      if (this.foreground?.visible()) {
        this.foreground.show(key, title, () => { onClick(); this.clear(key); }, body);
        return;
      }
      const notification = new Notification(title, { body, tag: key, icon: appPath("kenan.png"), requireInteraction: important });
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
