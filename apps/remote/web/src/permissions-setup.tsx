import { useEffect, useRef, useState } from "react";
import { nativePlatform, nativeSessionReady, remote, type PhoneSetupStep, type PhoneStatus } from "./native";
import { phoneGrants, requestPhoneGrant } from "./phone-access";
import { auth } from "./person";

type PhoneState = { state: "loading" } | { state: "ready"; value: PhoneStatus } | { state: "error"; message: string };
const message = (failure: unknown) => failure instanceof Error ? failure.message : String(failure);

export function PermissionsSetup() {
  const [phone, setPhone] = useState<PhoneState>({ state: "loading" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const running = useRef(false);
  const mounted = useRef(false);
  const refreshPhone = useRef<(() => Promise<void>) | null>(null);
  useEffect(() => {
    if (!nativePlatform) return;
    mounted.current = true;
    const refresh = async () => {
      if (running.current || document.hidden) return;
      const current = ++generation.current;
      try {
        if (!remote.phoneStatus) throw new Error("This Android shell does not provide phone control. Update the app.");
        await nativeSessionReady();
        const value = await remote.phoneStatus();
        if (mounted.current && current === generation.current) setPhone({ state: "ready", value });
      } catch (failure) {
        if (mounted.current && current === generation.current) setPhone({ state: "error", message: message(failure) });
      }
    };
    refreshPhone.current = refresh;
    const identityChanged = () => { generation.current++; setPhone({ state: "loading" }); setError(""); void refresh(); };
    const visible = () => { if (!document.hidden) void refresh(); };
    void refresh();
    window.addEventListener("focus", visible);
    window.addEventListener("pi-app-foreground", visible);
    window.addEventListener("pi-auth", identityChanged);
    window.addEventListener("pi-person", identityChanged);
    document.addEventListener("visibilitychange", visible);
    return () => {
      mounted.current = false; generation.current++; refreshPhone.current = null;
      window.removeEventListener("focus", visible);
      window.removeEventListener("pi-app-foreground", visible);
      window.removeEventListener("pi-auth", identityChanged);
      window.removeEventListener("pi-person", identityChanged);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);
  if (!nativePlatform) return null;
  const run = async (key: string, operation: (active: () => boolean) => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    const current = ++generation.current;
    const user = auth.user, session = auth.session;
    const active = () => mounted.current && current === generation.current && user === auth.user && session === auth.session;
    setBusy(key); setError("");
    try {
      if (!remote.phoneStatus) throw new Error("Phone status is unavailable in this Android shell.");
      await nativeSessionReady();
      if (!active()) return;
      await operation(active);
      if (!active()) return;
      const value = await remote.phoneStatus();
      if (active()) setPhone({ state: "ready", value });
    } catch (failure) { if (active()) setError(message(failure)); }
    finally {
      running.current = false;
      if (mounted.current) { setBusy(null); if (!active()) void refreshPhone.current?.(); }
    }
  };
  const configure = (enabled: boolean) => run("enabled", async active => {
    if (!remote.phoneConfigure || !window.KenanRemote) throw new Error("Phone configuration is unavailable in this Android shell.");
    const environment = await window.KenanRemote.getState();
    if (!active()) return;
    await remote.phoneConfigure({ enabled, user: auth.user, environment: environment.id });
  });
  const grant = (step: PhoneSetupStep, instruction: string) => run(step, async active => {
    if (!remote.phoneSetup || !remote.phoneStatus) throw new Error("Permission setup is unavailable in this Android shell.");
    const result = await requestPhoneGrant({ active, status: () => remote.phoneStatus!(), request: step => remote.phoneSetup!({ step, instruction }) }, step);
    if (!active()) return;
    switch (result.state) {
      case "granted": setPhone({ state: "ready", value: result.status }); break;
      case "denied": setPhone({ state: "ready", value: result.status }); setError("Android has not granted this permission. Other grants are unchanged."); break;
      case "error": setError(result.message); break;
      case "cancelled": break;
    }
  });
  const status = phone.state === "ready" ? phone.value : null;
  const disabled = busy !== null || !auth.session;
  return <div className="settings-phone">
    {phone.state === "loading" && <p role="status">Checking this phone…</p>}
    {phone.state === "error" && <><p role="alert">{phone.message}</p><button type="button" disabled={busy !== null} onClick={() => void refreshPhone.current?.()}>Retry phone status</button></>}
    {status && <>
      <div className="settings-switch-row"><div><strong>Enable phone control</strong><p>Connect this device to Kenan. Only the permissions granted below are available.</p></div>
        <input type="checkbox" aria-label="Enable phone control" checked={status.enabled} disabled={disabled || !remote.phoneConfigure} onChange={event => void configure(event.target.checked)} />
      </div>
      <p role="status">{status.name} · {status.enabled ? status.connected ? "Connected" : "Reconnecting" : "Phone control is off"}</p>
      {typeof status.overlay === "boolean" && remote.phoneOverlay ? <div className="settings-switch-row"><div><strong>Show Kenan over other apps</strong><p>Independent of phone-control permissions.</p></div>
        <input type="checkbox" aria-label="Show Kenan over other apps" checked={status.overlay} disabled={disabled || (!status.overlay && status.capabilities.overlay !== true)} onChange={event => {
          const visible = event.target.checked;
          void run("overlay-visible", async () => { await remote.phoneOverlay!({ visible }); });
        }} />
      </div> : <p>Overlay preferences are unavailable in this Android shell.</p>}
      <details className="settings-phone-grants"><summary>Device permissions</summary>
        <p>Each grant is separate. Enabling phone control does not grant access or perform an action.</p>
        <ul>{phoneGrants.map(({ step, label, help }) => {
          const capability = status.capabilities[step];
          const known = typeof capability === "boolean";
          return <li key={step}><div><strong>{label}</strong><p>{help}</p></div><div className="settings-grant-action">
            <span>{known ? capability ? "Granted" : "Not granted" : "Unavailable"}</span>
            {known && !capability && <button type="button" disabled={disabled || !remote.phoneSetup || (step === "backgroundLocation" && status.capabilities.location !== true)} onClick={() => void grant(step, help)}>{busy === step ? "Waiting for Android…" : "Grant"}</button>}
          </div></li>;
        })}</ul>
      </details>
      {status.error && <p role="alert">{typeof status.error === "string" ? status.error : status.error.message}</p>}
    </>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
