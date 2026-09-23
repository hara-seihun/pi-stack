import { useCallback, useEffect, useRef, useState } from "react";
import { deadline } from "./abortable";
import { DismissibleError } from "./dismissible-error";
import { nativePlatform, remote, type AppUpdate, type AppUpdateCheck } from "./native";

type Availability =
  | { status: "checking" }
  | { status: "current"; checked: AppUpdateCheck }
  | { status: "available"; checked: AppUpdateCheck; update: AppUpdate }
  | { status: "failed"; message: string };

type InstallState = "idle" | "installing" | "installer-opened" | "reloading";

let activeCheck: Promise<AppUpdateCheck> | null = null;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function checkForUpdate() {
  if (activeCheck) return activeCheck;
  if (!remote.checkAppUpdate) return Promise.reject(new Error("App update checks are unavailable"));

  const promise = deadline(remote.checkAppUpdate(), 30_000, "App update check").finally(() => {
    if (activeCheck === promise) activeCheck = null;
  });
  activeCheck = promise;
  return promise;
}

function availability(checked: AppUpdateCheck): Availability {
  return checked.update ? { status: "available", checked, update: checked.update } : { status: "current", checked };
}

export function AppUpdateControl() {
  const [available, setAvailable] = useState<Availability>({ status: "checking" });
  const [install, setInstall] = useState<InstallState>("idle");
  const [installError, setInstallError] = useState("");
  const generation = useRef(0);
  const installing = useRef(false);

  const check = useCallback(async () => {
    if (installing.current) return;
    const request = ++generation.current;
    setInstall("idle");
    setAvailable({ status: "checking" });
    try {
      const checked = await checkForUpdate();
      if (generation.current === request) setAvailable(availability(checked));
    } catch (error) {
      if (generation.current === request) setAvailable({ status: "failed", message: errorMessage(error) });
    }
  }, []);

  useEffect(() => {
    if (!nativePlatform || !remote.checkAppUpdate || !remote.installAppUpdate) return;
    void check();
    const foreground = () => { void check(); };
    window.addEventListener("pi-app-foreground", foreground);
    return () => {
      generation.current++;
      window.removeEventListener("pi-app-foreground", foreground);
    };
  }, [check]);

  if (!nativePlatform || !remote.checkAppUpdate || !remote.installAppUpdate) return null;

  const startInstall = async () => {
    if (available.status !== "available" || installing.current) return;
    installing.current = true;
    setInstall("installing");
    setInstallError("");
    try {
      const result = await remote.installAppUpdate!();
      // A web bundle reloads this page from the shell; the state below only shows until then.
      setInstall(result.status === "reloading" ? "reloading" : "installer-opened");
    } catch (error) {
      setInstall("idle");
      setInstallError(errorMessage(error));
      installing.current = false;
      await check();
    } finally {
      installing.current = false;
    }
  };

  if (available.status === "checking" && !installError && install !== "installing") return null;
  if (available.status === "current" && !installError && install === "idle") return null;

  const web = available.status === "available" && available.update.kind === "web";
  const installLabel = install === "installing"
    ? web ? "Applying update…" : "Downloading update…"
    : install === "reloading"
      ? "Restarting…"
      : install === "installer-opened"
        ? "Reopen installer"
        : installError ? "Retry update" : "Update app";
  return <section className="app-update" aria-label="App update" aria-live="polite">
    <DismissibleError message={installError} dismissLabel="Dismiss update install error" />
    {available.status === "failed" && <><DismissibleError message={`Update check failed. ${available.message}`} dismissLabel="Dismiss update check error" /><button type="button" onClick={() => void check()}>Retry check</button></>}
    {available.status === "current" && installError && <p className="app-update-detail">No app update is currently available.</p>}
    {available.status === "available" && <>
      <p className="app-update-detail">{web
        ? `Update ${available.update.revision.slice(0, 12)} is ${available.update.ready ? "downloaded" : "available"}. It applies in place and restarts the app view.`
        : `Update ${available.update.revision.slice(0, 12)} needs a new app package. Android may ask you to allow installs from Kenan.`}</p>
      <button type="button" disabled={install === "installing" || install === "reloading"} onClick={() => void startInstall()}>{installLabel}</button>
    </>}
    {install === "installer-opened" && <p className="app-update-detail" role="status">Finish the update in the Android installer.</p>}
  </section>;
}
