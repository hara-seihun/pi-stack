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
  useEffect(() => {
    if (!nativePlatform) return;
    const refresh = () => void remote.writeStatus!().then(setStatus).catch(err => setError(String(err)));
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, []);
  if (!nativePlatform) return null;
  const setup = async (step: typeof steps[number][0] | "keyboard", required?: boolean) => {
    try {
      setError("");
      await remote.writeSetup!({ step, required });
      setStatus(await remote.writeStatus!());
    } catch (err) { setError(String(err)); }
  };
  return <div className="notification-control">
    <p>Speak into any editable field. Tap the floating ✦, then ✓ to insert or ✗ to cancel. Hold ✦ to talk. Password, number and phone fields are excluded.</p>
    {steps.map(([step, label]) => <p key={step}>
      {status?.[step] ? `✓ ${label}` : <button type="button" onClick={() => void setup(step)}>{label}</button>}
    </p>)}
    <label><input type="checkbox" checked={status?.keyboardRequired ?? true}
      onChange={event => void setup("keyboard", event.target.checked)} /> Show only while the keyboard is open</label>
    {error && <p role="alert">{error}</p>}
  </div>;
}
