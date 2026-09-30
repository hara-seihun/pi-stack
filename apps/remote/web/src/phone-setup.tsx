import { useEffect, useState } from "react";
import { nativePlatform, nativeSessionReady, remote, type PhoneSetupStep, type PhoneStatus } from "./native";
import { auth } from "./person";

type Grant = readonly [PhoneSetupStep, string];
const baseline: readonly Grant[] = [
  ["accessibility", "Control apps and capture ordinary screens"],
  ["notifications", "Show the ongoing phone-control notification"],
  ["battery", "Allow background operation"],
];
const additional: readonly Grant[] = [
  ["notificationAccess", "Read notifications and use their actions/replies"],
  ["allFiles", "Read and write shared files"],
  ["contacts", "Read and update contacts"],
  ["calendar", "Read and update calendar events"],
  ["location", "Read precise location"],
  ["backgroundLocation", "Read location while Kenan is in the background"],
  ["sms", "Read and send SMS"],
  ["callLog", "Read call history"],
  ["phone", "Place calls"],
  ["usage", "Read app usage history"],
  ["camera", "Allow camera for supported foreground features"],
  ["microphone", "Allow microphone for supported recording features"],
  ["writeSettings", "Change supported system settings"],
  ["deviceAdmin", "Allow remote screen locking (optional)"],
];

/** Native, session-owned setup; returning from Android settings refreshes effective grants. */
export function PhoneSetup() {
  const [status, setStatus] = useState<PhoneStatus | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [supported, setSupported] = useState(true);
  useEffect(() => {
    if (!nativePlatform) return;
    let active = true;
    let refreshing = false;
    const refresh = async () => {
      if (refreshing || document.hidden) return;
      refreshing = true;
      try {
        await nativeSessionReady();
        const value = await remote.phoneStatus!();
        if (active) { setStatus(value); setSupported(true); }
      } catch (failure) {
        if (active) { setSupported(false); setError(String(failure)); }
      } finally { refreshing = false; }
    };
    const identityChanged = () => { setStatus(null); setName(""); void refresh(); };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    window.addEventListener("focus", refresh);
    window.addEventListener("pi-auth", identityChanged);
    window.addEventListener("pi-person", identityChanged);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("pi-auth", identityChanged);
      window.removeEventListener("pi-person", identityChanged);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  if (!nativePlatform) return null;
  if (!supported) return <p>Install the latest Android app to enable phone control. {error && <span role="alert">{error}</span>}</p>;
  const run = async (operation: () => Promise<void>) => {
    setBusy(true); setError("");
    try {
      await nativeSessionReady();
      await operation();
      setStatus(await remote.phoneStatus!());
    } catch (failure) { setError(String(failure)); }
    finally { setBusy(false); }
  };
  const configure = (enabled: boolean) => run(async () => {
    const environment = enabled ? (await window.KenanRemote!.getState()).id : status?.environment || "";
    await remote.phoneConfigure!({ enabled, user: auth.user, environment, ...(name.trim() ? { name: name.trim() } : {}) });
  });
  const grants = (items: readonly Grant[]) => items.map(([step, label]) => <p key={step}>
    {status?.capabilities[step] === true ? <span>✓ {label}</span> : <button type="button" disabled={busy || !status}
      onClick={() => void run(() => remote.phoneSetup!({ step }))}>{label}</button>}
  </p>);
  return <div className="notification-control phone-control">
    <p>Let your agent operate this phone over Tailscale, including mobile data. Approve access once here; commands do not need a new acceptance dialog each time.</p>
    <p role="status">{status ? status.enabled ? status.connected ? "Connected" : "Enabled · reconnecting" : "Phone control is off" : "Loading phone capabilities…"}
      {status?.environment && ` · ${status.environment}`}</p>
    {status?.error && <p role="alert">{status.error}</p>}
    <label>Phone name <input type="text" maxLength={80} disabled={busy} value={name} placeholder={status?.name || "My phone"}
      onChange={event => setName(event.target.value)} /></label>
    <p><button type="button" disabled={busy || !status || !auth.session} onClick={() => void configure(!status?.enabled)}>
      {status?.enabled ? "Disable phone control" : "Enable for this person and environment"}</button>
      {status?.enabled && <button type="button" disabled={busy} onClick={() => void configure(true)}>Use current environment / save name</button>}</p>
    {grants(baseline)}
    <details><summary>Additional one-time access</summary>
      <p>Only enable what you want your agent to use. Revoking a grant disables that capability, not the connection.</p>
      {grants(additional)}
      <p>Microphone and camera grants are shared with ordinary recording/meeting features. Phone control does not expose unrestricted background recording.</p>
    </details>
    <details><summary>Optional Device Owner / ADB permissions</summary>
      <p>Device Owner: {status?.capabilities.deviceOwner === true ? "enabled" : "not provisioned"}. Full device management requires separate fully-managed provisioning, often after a factory reset; this screen never resets or enrolls your phone.</p>
      <p>Secure-settings grant: {status?.capabilities.secureSettings === true ? "enabled" : "not granted"}. Optional one-time USB ADB command:</p>
      <pre><code>adb shell pm grant works.kenan.piremote.kenan android.permission.WRITE_SECURE_SETTINGS</code></pre>
      <p>Neither option is required for the phone connection or Accessibility control.</p>
    </details>
    {status?.deviceId && <p>CLI: <code>pi-phone --device {status.deviceId} status</code></p>}
    <p>Secure screens and private app data remain protected. After a reboot the first unlock may be needed. Force-stopping Kenan stops control until you open it again. Keep Tailscale connected.</p>
    {error && <p role="alert">{error}</p>}
  </div>;
}
