import { useEffect, useRef, useState } from "react";
import { nativePlatform, nativeSessionReady, remote, type PhoneSetupStep, type PhoneStatus } from "./native";
import { phoneGrants, requestPhoneAccess } from "./phone-access";
import { auth } from "./person";

export function PhoneSetup() {
  const [status, setStatus] = useState<PhoneStatus | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [supported, setSupported] = useState(true);
  const [progress, setProgress] = useState<PhoneSetupStep | null>(null);
  const [completed, setCompleted] = useState(false);
  const [failures, setFailures] = useState<Partial<Record<PhoneSetupStep, string>>>({});
  const generation = useRef(0);
  const running = useRef(false);
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
    const identityChanged = () => {
      generation.current++;
      setStatus(null); setName(""); setCompleted(false); setFailures({}); setProgress(null); setBusy(running.current);
      void refresh();
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    window.addEventListener("focus", refresh);
    window.addEventListener("pi-auth", identityChanged);
    window.addEventListener("pi-person", identityChanged);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      active = false; generation.current++;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("pi-auth", identityChanged);
      window.removeEventListener("pi-person", identityChanged);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  if (!nativePlatform) return null;
  if (!supported) return <p>Install the latest Android app to enable phone control. {error && <span role="alert">{error}</span>}</p>;
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
      if (active()) {
        const value = await remote.phoneStatus!();
        if (active()) setStatus(value);
      }
    } catch (failure) { if (active()) setError(String(failure)); }
    finally {
      running.current = false;
      setBusy(false);
      if (active()) setProgress(null);
    }
  };
  const configure = async (enabled: boolean, active: () => boolean) => {
    const user = auth.user;
    const environment = enabled ? (await window.KenanRemote!.getState()).id : status?.environment || "";
    if (!active()) return;
    await remote.phoneConfigure!({ enabled, user, environment, ...(name.trim() ? { name: name.trim() } : {}) });
  };
  const setup = () => run(async active => {
    setCompleted(false); setFailures({});
    const result = await requestPhoneAccess({
      status: () => remote.phoneStatus!(),
      request: step => remote.phoneSetup!({ step, instruction: phoneGrants.find(grant => grant.step === step)!.help }), active,
      progress: step => { setProgress(step); },
    });
    if (!active()) return;
    setStatus(result.status); setFailures(result.failures); setCompleted(result.completed); setProgress(null);
    if (result.completed) await configure(true, active);
  });
  const missing = phoneGrants.filter(grant => status?.capabilities[grant.step] !== true);
  const granted = phoneGrants.filter(grant => status?.capabilities[grant.step] === true);
  const currentGrant = phoneGrants.find(grant => grant.step === progress);
  return <div className="notification-control phone-control">
    <p>Let your agent operate this phone over Tailscale, including mobile data. One button walks through Android’s access requests and connects this person and environment. You can decline any request; already-granted access is skipped.</p>
    <p role="status">{status ? status.enabled ? status.connected ? "Connected" : "Enabled · reconnecting" : "Phone control is off" : "Loading phone capabilities…"}
      {status?.environment && ` · ${status.environment}`}</p>
    {status?.error && <p role="alert">{typeof status.error === "string" ? status.error : status.error.message}</p>}
    <label>Phone name <input type="text" maxLength={80} disabled={busy} value={name} placeholder={status?.name || "My phone"}
      onChange={event => setName(event.target.value)} /></label>
    <p><button type="button" disabled={busy || !status || !auth.session} onClick={() => void setup()}>
      {busy ? progress ? "Setting up phone access…" : "Finishing access request…" : completed && missing.length ? "Retry missing access" : status?.enabled ? missing.length ? "Complete phone access" : "Phone access is ready" : "Set up phone access"}</button>
      {status?.enabled && <button type="button" disabled={busy} onClick={() => void run(active => configure(false, active))}>Disable phone control</button>}
      {busy && <button type="button" onClick={() => { generation.current++; setProgress(null); }}>Stop setup</button>}</p>
    {currentGrant && <p role="status">Step {phoneGrants.indexOf(currentGrant) + 1} of {phoneGrants.length}: {currentGrant.label}. {currentGrant.help} Approve or go back to skip; setup continues when you return.</p>}
    {status && !progress && <section aria-label="Phone access summary">
      <p role="status">{completed ? "Access setup finished. " : ""}{granted.length} granted · {missing.length} not granted.</p>
      {completed && <>
        <p>Granted: {granted.map(grant => grant.label).join(", ") || "none"}.</p>
        {missing.length > 0 && <><p>Declined, restricted or unavailable:</p><ul>{missing.map(grant => <li key={grant.step}>
          {grant.label}{failures[grant.step] ? ` — ${failures[grant.step]}` : " — not granted"}
        </li>)}</ul><p>Retry requests only the access still missing. The connection works with whichever capabilities you approved.</p></>}
      </>}
    </section>}
    {status?.overlay !== undefined && <p><label><input type="checkbox" disabled={busy || status.capabilities.accessibility !== true} checked={status.overlay}
      onChange={event => { const visible = event.target.checked; void run(async () => { await remote.phoneOverlay!({ visible }); }); }} /> Show Kenan over other apps</label>
      {" "}Tap the dot to talk to Kenan anywhere; it also shows what Kenan taps, swipes and types.</p>}
    <details><summary>Advanced / access details</summary>
      <p>Revoking access disables that capability, not the connection. Microphone and camera are shared with supported foreground features; phone control does not expose unrestricted background recording.</p>
      {phoneGrants.map(({ step, label, help }) => <p key={step}>
        {status?.capabilities[step] === true ? <span>✓ {label}</span> : <button type="button" disabled={busy || !status}
          onClick={() => void run(async () => { await remote.phoneSetup!({ step, instruction: help }); })}>{label}</button>} {help}
      </p>)}
      <button type="button" disabled={busy || !status || !auth.session} onClick={() => void run(active => configure(true, active))}>Use current environment / save name</button>
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
