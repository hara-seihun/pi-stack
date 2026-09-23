import { useCallback, useEffect, useRef, useState } from "react";
import type { MessagingBackendInfo } from "../../server/messaging/protocol";
import { DismissibleError } from "./dismissible-error";
import { messagingClient } from "./messaging-client";

/**
 * What the account owner should see for this backend's account link. A ready
 * backend needs no linking; everything else follows the last attempt the
 * supervisor reported through the messaging snapshot.
 */
export function linkStage(backend: MessagingBackendInfo): "hidden" | "idle" | "waiting" | "connecting" | "failed" {
  if (!backend.linkable) return "hidden";
  if (backend.status === "ready") return "hidden";
  const link = backend.link;
  if (link?.status === "waiting") return "waiting";
  if (link?.status === "linked") return "connecting";
  if (link?.status === "failed") return "failed";
  return "idle";
}

export function MessagingLinkPanel({ backend, deviceName, onDeviceName, onStart, onCancel, busy, error, copied, onCopy }: {
  backend: MessagingBackendInfo;
  deviceName: string;
  onDeviceName(value: string): void;
  onStart(): void;
  onCancel(): void;
  busy: boolean;
  error: string;
  copied: boolean;
  onCopy(): void;
}) {
  const stage = linkStage(backend);
  if (stage === "hidden") return null;
  const link = backend.link;
  return <section className="messaging-link">
    {stage === "idle" && <>
      <p>Connect your own {backend.label} account. Your phone stays the main device; this becomes one of its linked devices.</p>
      <form onSubmit={event => { event.preventDefault(); onStart(); }}>
        <label>
          Device name
          <input value={deviceName} disabled={busy} maxLength={64} onChange={event => onDeviceName(event.target.value)} />
        </label>
        <button type="submit" className="messaging-link-start" disabled={busy || !deviceName.trim()}>Link {backend.label}</button>
      </form>
    </>}

    {stage === "waiting" && <>
      <ol className="messaging-link-steps">
        <li>Open {backend.label} on your phone.</li>
        <li>Go to Settings, then Linked devices, then Link new device.</li>
        <li>Scan this code. On the phone you are reading this on, open the link below instead.</li>
      </ol>
      {link?.qr
        ? <div className="messaging-link-qr" role="img" aria-label={`${backend.label} device link code`} dangerouslySetInnerHTML={{ __html: link.qr }} />
        : <p className="messaging-link-plain">This host cannot draw the code. Use the link below on the phone that has {backend.label}.</p>}
      {link?.uri && <p className="messaging-link-uri"><a href={link.uri}>Open in {backend.label} on this device</a></p>}
      <div className="messaging-link-actions">
        <button type="button" disabled={!link?.uri} onClick={onCopy}>{copied ? "Link copied" : "Copy link"}</button>
        <button type="button" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
      <p role="status">Waiting for your phone to accept the link. The code expires after a few minutes; start again for a fresh one.</p>
    </>}

    {stage === "connecting" && <p role="status">Linked as {link?.account}. Connecting…</p>}

    {stage === "failed" && <>
      <p role="alert">{link?.error || "The link attempt failed."}</p>
      <button type="button" className="messaging-link-start" disabled={busy} onClick={onStart}>Try again</button>
    </>}

    <DismissibleError message={error} />
  </section>;
}

export function MessagingLinkController({ backend }: { backend: MessagingBackendInfo }) {
  const [deviceName, setDeviceName] = useState("PiStack");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const operation = useRef<AbortController | null>(null);
  useEffect(() => () => operation.current?.abort(), []);
  const uri = backend.link?.uri ?? "";
  useEffect(() => { setCopied(false); }, [uri]);

  const run = useCallback(async (request: (signal: AbortSignal) => ReturnType<typeof messagingClient.link>) => {
    if (operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true); setError("");
    const result = await request(controller.signal);
    if (controller.signal.aborted) return;
    operation.current = null; setBusy(false);
    if (!result.ok) setError(result.error.message);
  }, []);

  const copy = useCallback(() => {
    if (!uri) return;
    void navigator.clipboard?.writeText(uri).then(() => setCopied(true), () => setError("This browser would not copy the link. Select it manually."));
  }, [uri]);

  return <MessagingLinkPanel
    backend={backend}
    deviceName={deviceName}
    onDeviceName={setDeviceName}
    onStart={() => void run(signal => messagingClient.link(backend.id, deviceName.trim(), signal))}
    onCancel={() => void run(signal => messagingClient.cancelLink(backend.id, signal))}
    busy={busy}
    error={error}
    copied={copied}
    onCopy={copy}
  />;
}
