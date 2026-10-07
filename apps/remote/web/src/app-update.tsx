import { useEffect, useSyncExternalStore } from "react";
import { deadline } from "./abortable";
import { DismissibleError } from "./dismissible-error";
import { bootstrapUrl, nativePlatform, remote } from "./native";
import { AppUpdater, startAppUpdateChecks } from "./app-update-state";

const enabled = nativePlatform && !!remote.checkAppUpdate && !!remote.installAppUpdate;
const attemptKey = "pi-auto-apk-install";
let storage: Storage | null;
try { storage = window.sessionStorage; } catch { storage = null; }
const updater = new AppUpdater({
  check: async () => {
    await bootstrapUrl();
    return deadline(remote.checkAppUpdate!(), 30_000, "App update check");
  },
  install: () => remote.installAppUpdate!(),
  attempted: revision => storage?.getItem(attemptKey) === revision,
  remember: revision => {
    if (!storage) return;
    try { storage.setItem(attemptKey, revision); }
    catch { storage = null; } // The controller retains attempts in memory when browser storage is unavailable.
  },
});

export function useAppUpdate() {
  const state = useSyncExternalStore(updater.subscribe, updater.snapshot, updater.snapshot);
  useEffect(() => {
    if (!enabled) return;
    return startAppUpdateChecks(updater, {
      visible: () => document.visibilityState === "visible",
      schedule: (check, delay) => {
        const timer = setTimeout(check, delay);
        return () => clearTimeout(timer);
      },
      subscribe: check => {
        window.addEventListener("pi-app-foreground", check);
        window.addEventListener("online", check);
        document.addEventListener("visibilitychange", check);
        return () => {
          window.removeEventListener("pi-app-foreground", check);
          window.removeEventListener("online", check);
          document.removeEventListener("visibilitychange", check);
        };
      },
    });
  }, []);
  return { ...state, onClick: () => { if (enabled) void updater.check(true); } };
}

export function AppUpdateStatus({ update }: { update: ReturnType<typeof useAppUpdate> }) {
  if (!update.error && !update.approval) return null;
  return <section className="app-update" aria-label="App update" aria-live="polite">
    <DismissibleError message={update.error} dismissLabel="Dismiss update error" />
    {update.error && <button type="button" disabled={update.busy} onClick={update.onClick}>Retry update</button>}
    {update.approval && <p role="status">{update.status}</p>}
  </section>;
}
