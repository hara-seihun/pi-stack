import { useCallback, useEffect, useRef, useState } from "react";
import { deadline } from "./abortable";
import { DismissibleError } from "./dismissible-error";
import { nativePlatform, remote, type AppUpdateCheck } from "./native";

type Availability =
  | { status: "checking" }
  | { status: "current"; checked: AppUpdateCheck }
  | { status: "available"; checked: AppUpdateCheck & { release: NonNullable<AppUpdateCheck["release"]> } }
  | { status: "failed"; message: string };

type InstallState = "idle" | "installing" | "installer-opened";

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
  return checked.release && checked.release.versionCode > checked.installed.versionCode
    ? { status: "available", checked: checked as AppUpdateCheck & { release: NonNullable<AppUpdateCheck["release"]> } }
    : { status: "current", checked };
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
      await remote.installAppUpdate!();
      setInstall("installer-opened");
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
  if (available.status === "current" && !installError && install !== "installer-opened") return null;

  return <section className="app-update" aria-label="App update">
    <DismissibleError message={installError} dismissLabel="Dismiss update install error" />
    {available.status === "failed" && <><DismissibleError message={`Update check failed. ${available.message}`} dismissLabel="Dismiss update check error" /><button type="button" onClick={() => void check()}>Retry check</button></>}
    {available.status === "current" && installError && <p className="app-update-detail">No app update is currently available.</p>}
    {available.status === "available" && <>
      <p className="app-update-detail">Update {available.checked.release.revision.slice(0, 12)} is available. Android may ask you to allow installs from Kenan.</p>
      <button type="button" disabled={install === "installing"} onClick={() => void startInstall()}>{install === "installing" ? "Downloading update…" : installError ? "Retry update" : "Update app"}</button>
      {install === "installing" && <p className="app-update-detail" role="status">Downloading the app and opening the Android installer.</p>}
    </>}
    {install === "installer-opened" && <p className="app-update-detail" role="status">Finish the update in the Android installer. If you cancelled it, tap Update app to reopen it.</p>}
  </section>;
}
