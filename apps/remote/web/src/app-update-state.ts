import type { AppUpdate, AppUpdateCheck, AppUpdateInstall } from "./native";

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

export class AppUpdater {
  private state = initial;
  private update: AppUpdate | null = null;
  private checking: Promise<void> | null = null;
  private listeners = new Set<() => void>();
  private attempts = new Set<string>();
  constructor(private port: UpdatePort) {}

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
    const operation = this.run(manual).finally(() => { this.checking = null; });
    this.checking = operation;
    return operation;
  };

  private async run(manual: boolean) {
    try {
      this.update = (await this.port.check()).update;
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
      if (result.status === "installer-opened") {
        this.remember(result.revision ?? update.revision);
        this.publish({ visible: true, busy: false, status: "Finish the update in Android. Tap Update to reopen installation.", error: "", approval: true });
      } else {
        this.publish({ visible: true, busy: true, status: "Restarting…", error: "", approval: false });
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
