import { useEffect, useRef, useState } from "react";
import { nativePlatform, nativeSessionReady, remote, type PhoneSetupStep, type PhoneStatus } from "./native";
import { allPermissionsGranted, phoneGrants, requestPhoneAccess } from "./phone-access";
import { auth } from "./person";

type WriteStatus = Awaited<ReturnType<NonNullable<typeof remote.writeStatus>>>;

export function PermissionsSetup() {
  const [status, setStatus] = useState<PhoneStatus | null>(null);
  const [write, setWrite] = useState<WriteStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<PhoneSetupStep | null>(null);
  const generation = useRef(0);
  const running = useRef(false);
  useEffect(() => {
    if (!nativePlatform) return;
    let mounted = true;
    let refreshing = false;
    const refresh = async () => {
      if (refreshing || running.current || document.hidden) return;
      const current = generation.current;
      refreshing = true;
      try {
        await nativeSessionReady();
        const [phone, dictation] = await Promise.all([remote.phoneStatus!(), remote.writeStatus!()]);
        if (mounted && current === generation.current) { setStatus(phone); setWrite(dictation); }
      } catch (failure) {
        if (mounted && current === generation.current) setError(String(failure));
      } finally { refreshing = false; }
    };
    const identityChanged = () => {
      generation.current++;
      setStatus(null); setWrite(null); setError(""); setProgress(null);
      void refresh();
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    window.addEventListener("focus", refresh);
    window.addEventListener("pi-auth", identityChanged);
    window.addEventListener("pi-person", identityChanged);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      mounted = false; generation.current++;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("pi-auth", identityChanged);
      window.removeEventListener("pi-person", identityChanged);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  if (!nativePlatform) return null;
  const supported = status && typeof status.capabilities.writeAccessibility === "boolean";
  const run = async (operation: (active: () => boolean) => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    const current = ++generation.current;
    const session = auth.session;
    const user = auth.user;
    const active = () => current === generation.current && auth.session === session && auth.user === user;
    setBusy(true); setError("");
    try {
      await nativeSessionReady();
      if (!active()) return;
      await operation(active);
      if (!active()) return;
      const [phone, dictation] = await Promise.all([remote.phoneStatus!(), remote.writeStatus!()]);
      if (active()) { setStatus(phone); setWrite(dictation); }
    } catch (failure) { if (active()) setError(String(failure)); }
    finally {
      running.current = false;
      setBusy(false);
      if (active()) setProgress(null);
    }
  };
  const setup = () => run(async active => {
    const result = await requestPhoneAccess({
      status: () => remote.phoneStatus!(), active,
      request: step => remote.phoneSetup!({ step, instruction: phoneGrants.find(grant => grant.step === step)!.help }),
      progress: step => setProgress(step),
    });
    if (!active()) return;
    setStatus(result.status); setProgress(null);
    if (!result.granted) {
      const missing = phoneGrants.find(grant => result.status.capabilities[grant.step] !== true);
      if (missing) setError(result.failures[missing.step] || `Android has not granted ${missing.label.toLowerCase()}. Grant all permissions to continue.`);
      return;
    }
    const environment = (await window.KenanRemote!.getState()).id;
    if (!active()) return;
    await remote.writeEnvironment!({ user: auth.user, environment });
    if (!active()) return;
    const notifications = await remote.notifications!({ request: true });
    if (!active()) return;
    if (!notifications.enabled) { setError("Android has not allowed notifications. Grant all permissions to continue."); return; }
    await remote.writeSetup!({ step: "enabled", enabled: true });
    if (!active()) return;
    await remote.phoneConfigure!({ enabled: true, user: auth.user, environment });
    if (!active()) return;
    await remote.phoneOverlay!({ visible: true });
  });
  const ready = status && allPermissionsGranted(status) && status.enabled;
  const currentGrant = phoneGrants.find(grant => grant.step === progress);
  return <div className="notification-control">
    <p role="status"><strong>{status ? supported ? ready ? "Ready · all permissions granted" : "Not ready" : "Android app update required" : "Checking permissions…"}</strong></p>
    {!supported && status ? <p>Update the Android app to use the combined Pi Stack setup.</p> : <>
      <p>One setup for phone control, dictation, notifications and app updates. Pi Stack is ready only when every app permission is granted.</p>
      {!ready && <button type="button" disabled={busy || !status || !auth.session} onClick={() => void setup()}>
        {busy ? "Granting permissions…" : "Grant all permissions"}
      </button>}
      {busy && <button type="button" onClick={() => { generation.current++; setProgress(null); }}>Stop setup</button>}
      {currentGrant && <p role="status">{currentGrant.help} Android still needs your approval; setup continues when you return.</p>}
      {ready && !status.connected && <p role="status">Phone control is reconnecting.</p>}
      {ready && <details><summary>Overlay preferences</summary>
        <p><label><input type="checkbox" checked={status.overlay ?? false} disabled={busy}
          onChange={event => { const visible = event.target.checked; void run(async () => { await remote.phoneOverlay!({ visible }); }); }} /> Show Kenan over other apps</label></p>
        <p><label><input type="checkbox" checked={write?.overlayEnabled ?? false} disabled={busy || !write}
          onChange={event => { const enabled = event.target.checked; void run(async () => { await remote.writeSetup!({ step: "enabled", enabled }); }); }} /> Show Write microphone</label></p>
        <p><label><input type="checkbox" checked={write?.keyboardRequired ?? true} disabled={busy || !write}
          onChange={event => { const required = event.target.checked; void run(async () => { await remote.writeSetup!({ step: "keyboard", required }); }); }} /> Show microphone only while the keyboard is open</label></p>
      </details>}
    </>}
    {status?.error && <p role="alert">{typeof status.error === "string" ? status.error : status.error.message}</p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
