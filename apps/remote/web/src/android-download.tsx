import { useState } from "react";
import { appPath, appStorageKey } from "./app-path";
import { nativePlatform } from "./native";
import "./android-download.css";

import { androidDownloadUrl, offerAndroidApp } from "./android-app";

export function AndroidDownloadPrompt() {
  const key = appStorageKey("kenan-download-dismissed");
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(key) === "yes");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!offerAndroidApp(navigator.userAgent, nativePlatform, dismissed)) return null;
  const download = async () => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(appPath("v1/app-update"), { cache: "no-store", signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`Download check returned HTTP ${response.status}. Please retry.`);
      location.assign(androidDownloadUrl(await response.json()));
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  return <aside className="android-download" aria-label="Get the Android app">
    <span>Get Kenan for Android</span>
    <button type="button" disabled={busy} onClick={() => void download()}>{busy ? "Checking…" : "Download"}</button>
    <button type="button" aria-label="Dismiss app download" onClick={() => { localStorage.setItem(key, "yes"); setDismissed(true); }}>×</button>
    {error && <small role="alert">{error}</small>}
  </aside>;
}
