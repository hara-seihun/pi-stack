import { useEffect, useState } from "react";
import { nativePlatform, remote } from "./native";

type Status = Awaited<ReturnType<NonNullable<typeof remote.writeStatus>>>;
const steps = [
  ["microphone", "Allow microphone"],
  ["overlay", "Allow display over other apps"],
  ["accessibility", "Enable Pi Stack Write accessibility service"],
  ["notification", "Allow dictionary learning notifications with Undo"],
  ["battery", "Allow background operation (optional)"],
] as const;

export function WriteSetup() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!nativePlatform) return;
    const refresh = () => void remote.writeStatus!().then(setStatus).catch(err => setError(String(err)));
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, []);
  if (!nativePlatform) return null;
  const setup = async (options: Parameters<NonNullable<typeof remote.writeSetup>>[0]) => {
    setPending(true);
    try {
      setError("");
      await remote.writeSetup!(options);
      setStatus(await remote.writeStatus!());
    } catch (err) { setError(String(err)); }
    finally { setPending(false); }
  };
  return <div className="notification-control">
    <label><input type="checkbox" checked={status?.overlayEnabled ?? false}
      disabled={pending || typeof status?.overlayEnabled !== "boolean"}
      onChange={event => void setup({ step: "enabled", enabled: event.target.checked })} /> Show Write overlay</label>
    <p>Turning it off cancels active overlay dictation. Composer dictation and the Kenan overlay stay available.</p>
    {status && typeof status.overlayEnabled !== "boolean" && <p>Update the Android app to control the Write overlay.</p>}
    <p>Speak into any editable field. Tap the floating ✦, then ✓ to insert or ✗ to cancel. Hold ✦ to talk. Password, number and phone fields are excluded.</p>
    {steps.map(([step, label]) => <p key={step}>
      {status?.[step] ? `✓ ${label}` : <button type="button" disabled={pending || !status} onClick={() => void setup({ step })}>{label}</button>}
    </p>)}
    <label><input type="checkbox" checked={status?.keyboardRequired ?? true} disabled={pending || !status}
      onChange={event => void setup({ step: "keyboard", required: event.target.checked })} /> Show only while the keyboard is open</label>
    {error && <p role="alert">{error}</p>}
  </div>;
}
