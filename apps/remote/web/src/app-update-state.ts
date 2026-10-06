import type { AppUpdate, AppUpdateCheck, AppUpdateInstall } from "./native";
import { requireState } from "../../shared/explicit-state";

export interface UpdateState {
  visible: boolean;
  busy: boolean;
  status: string;
  error: string;
  approval: boolean;
}

export interface UpdatePort {
  check(): Promise<AppUpdateCheck>;
  install(): Promise<AppUpdateInstall>;
  attempted(revision: string): boolean;
  remember(revision: string): void;
}

const initial: UpdateState = { visible: false, busy: false, status: "", error: "", approval: false };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export interface UpdateLifecycle {
  visible(): boolean;
  subscribe(listener: () => void): () => void;
  schedule(listener: () => void, delayMs: number): () => void;
}

export function startAppUpdateChecks(updater: AppUpdater, lifecycle: UpdateLifecycle): () => void {
  let disposed = false;
  let running = false;
  let cancelTimer: (() => void) | null = null;
  const check = () => {
    cancelTimer?.(); cancelTimer = null;
    if (disposed || !lifecycle.visible() || running) return;
    running = true;
    void updater.checkFresh().finally(() => {
      running = false;
      if (!disposed && lifecycle.visible() && !updater.snapshot().busy) cancelTimer = lifecycle.schedule(check, updater.freshnessDelay());
    });
  };
  const unsubscribe = updater.subscribe(() => {
    if (!running && !updater.snapshot().busy) check();
  });
  const detach = lifecycle.subscribe(check);
  check();
  return () => {
    disposed = true;
    cancelTimer?.();
    unsubscribe(); detach();
  };
}

export const APP_UPDATE_FRESHNESS_MS = 5 * 60_000;
export const APP_UPDATE_RETRY_MS = 60_000;

export class AppUpdater {
  private state = initial;
  private update: AppUpdate | null = null;
  private checking: Promise<void> | null = null;
  private listeners = new Set<() => void>();
  private attempts = new Set<string>();
  private automaticAfter: number | null = null;
  constructor(private port: UpdatePort, private now: () => number = Date.now) {}

  freshnessDelay = () => this.automaticAfter === null ? 0 : Math.max(0, this.automaticAfter - this.now());
  checkFresh = (): Promise<void> => this.freshnessDelay() > 0 ? Promise.resolve() : this.check();

  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(state: UpdateState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  check = (manual = false): Promise<void> => {
    if (this.state.busy) return Promise.resolve();
    if (this.checking) return this.checking;
    const operation = this.run(manual).finally(() => {
      this.automaticAfter = this.now() + (this.state.error ? APP_UPDATE_RETRY_MS : APP_UPDATE_FRESHNESS_MS);
      this.checking = null;
    });
    this.checking = operation;
    return operation;
  };

  private async run(manual: boolean) {
    try {
      const checked = (await this.port.check()).update;
      if (checked !== null) requireState(checked.kind, { apk: true, web: true } satisfies Record<AppUpdate["kind"], true>, "App update kind");
      this.update = checked;
    } catch (error) {
      this.publish({ ...this.state, error: `Update check failed. ${message(error)}` });
      return;
    }
    const update = this.update;
    if (!update) {
      this.publish(initial);
      return;
    }
    const attempted = update.kind === "apk" && (this.attempts.has(update.revision) || this.port.attempted(update.revision));
    if (attempted && !manual) {
      this.publish({ visible: true, busy: false, status: "Finish the update in Android. Tap Update to reopen installation.", error: this.state.error, approval: true });
      return;
    }
    this.publish({ visible: true, busy: true, status: update.kind === "web" ? "Applying update…" : "Downloading update…", error: "", approval: false });
    try {
      const result = await this.port.install();
      requireState(result.status, { "installer-opened": true, reloading: true } satisfies Record<AppUpdateInstall["status"], true>, "App installation result");
      switch (result.status) {
        case "installer-opened":
          this.remember(result.revision ?? update.revision);
          this.publish({ visible: true, busy: false, status: "Finish the update in Android. Tap Update to reopen installation.", error: "", approval: true });
          break;
        case "reloading": this.publish({ visible: true, busy: true, status: "Restarting…", error: "", approval: false }); break;
      }
    } catch (error) {
      const failure = message(error);
      // Android's explicit refusal is not a failed transfer to retry every minute.
      if (update.kind === "apk" && failure.includes("Allow installs from Kenan")) this.remember(update.revision);
      this.publish({ visible: true, busy: false, status: "Update needs retry. Tap Update to retry.", error: failure, approval: false });
    }
  }

  private remember(revision: string) {
    this.attempts.add(revision);
    this.port.remember(revision);
  }
}
