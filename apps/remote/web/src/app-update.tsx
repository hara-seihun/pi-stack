import { useCallback, useEffect, useRef, useState } from "react";
import { deadline } from "./abortable";
import { nativePlatform, remote, type AppUpdateCheck } from "./native";

type Availability =
  | { status: "checking" }
  | { status: "current"; checked: AppUpdateCheck }
  | { status: "available"; checked: AppUpdateCheck & { release: NonNullable<AppUpdateCheck["release"]> } }
  | { status: "failed"; message: string };

type InstallState = "idle" | "installing" | "installer-opened";

let activeCheck: Promise<AppUpdateCheck> | null = null;
let recentCheck: { startedAt: number; promise: Promise<AppUpdateCheck> } | null = null;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function checkForUpdate(fresh = false) {
  if (activeCheck) return activeCheck;
  if (!fresh && recentCheck && Date.now() - recentCheck.startedAt < 1_500) return recentCheck.promise;
  if (!remote.checkAppUpdate) return Promise.reject(new Error("App update checks are unavailable"));

  const promise = deadline(remote.checkAppUpdate(), 8_000, "App update check").finally(() => {
    if (activeCheck === promise) activeCheck = null;
  });
  activeCheck = promise;
  recentCheck = { startedAt: Date.now(), promise };
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

  const check = useCallback(async (fresh = false) => {
    if (installing.current) return;
    const request = ++generation.current;
    setInstall("idle");
    setAvailable({ status: "checking" });
    try {
      const checked = await checkForUpdate(fresh);
      if (generation.current === request) setAvailable(availability(checked));
    } catch (error) {
      if (generation.current === request) setAvailable({ status: "failed", message: errorMessage(error) });
    }
  }, []);

  useEffect(() => {
    if (!nativePlatform || !remote.checkAppUpdate || !remote.installAppUpdate) return;
    void check();
    const foreground = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", foreground);
    window.addEventListener("focus", foreground);
    window.addEventListener("pageshow", foreground);
    return () => {
      generation.current++;
      document.removeEventListener("visibilitychange", foreground);
      window.removeEventListener("focus", foreground);
      window.removeEventListener("pageshow", foreground);
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
      if (result.status === "installer-opened") setInstall("installer-opened");
      else {
        setInstall("idle");
        setInstallError("Allow installs from Kenan in Android settings, then return here. The downloaded APK is saved.");
        installing.current = false;
        await check(true);
      }
    } catch (error) {
      setInstall("idle");
      setInstallError(errorMessage(error));
      installing.current = false;
      await check(true);
    } finally {
      installing.current = false;
    }
  };

  if (available.status === "checking" && !installError && install !== "installing") return null;
  if (available.status === "current" && !installError && install !== "installer-opened") return null;

  return <section className="app-update" aria-label="App update">
    {installError && <p className="app-update-error" role="alert">{installError}</p>}
    {available.status === "failed" && <><p className="app-update-error" role="alert">Update check failed. {available.message}</p><button type="button" onClick={() => void check(true)}>Retry check</button></>}
    {available.status === "current" && installError && <p className="app-update-detail">No app update is currently available.</p>}
    {available.status === "available" && install !== "installer-opened" && <>
      <p className="app-update-detail">Update {available.checked.release.revision.slice(0, 12)} is available. Android may ask you to allow installs from Kenan.</p>
      <button type="button" disabled={install === "installing"} onClick={() => void startInstall()}>{install === "installing" ? "Downloading update…" : installError ? "Retry update" : "Update app"}</button>
      {install === "installing" && <p className="app-update-detail" role="status">Downloading the app and opening the Android installer.</p>}
    </>}
    {install === "installer-opened" && <p className="app-update-detail" role="status">Finish the update in the Android installer.</p>}
  </section>;
}
