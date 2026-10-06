import { useCallback, useEffect, useState } from "react";
import { API } from "../../server/api";
import type { NetworkStatus, PrivateNetwork } from "../../server/protocol";
import { appStorageKey } from "./app-path";
import { nativePlatform } from "./native";
import "./network-join.css";
import { assertNever } from "../../shared/explicit-state";

const SNOOZE_MS = 24 * 60 * 60 * 1000;

type Platform = "android" | "ios" | "desktop";

export function joinPlatform(userAgent: string, native: boolean): Platform {
  if (native || /Android/i.test(userAgent)) return "android";
  if (/iPhone|iPad|iPod/i.test(userAgent)) return "ios";
  return "desktop";
}

const DOWNLOADS: Record<Platform, { label: string; url: string }> = {
  android: { label: "Get Tailscale on Google Play", url: "https://play.google.com/store/apps/details?id=com.tailscale.ipn" },
  ios: { label: "Get Tailscale on the App Store", url: "https://apps.apple.com/app/tailscale/id1470499037" },
  desktop: { label: "Download Tailscale", url: "https://tailscale.com/download" },
};

function steps(platform: Platform, server: string) {
  switch (platform) {
    case "android": return [
      "Install Tailscale, or update it if you already have it.",
      "Open Tailscale. If you're signed in to the old network, open your profile → Accounts → ⋮ → Use an alternate server. On a fresh install, use the ⋮ menu on the sign-in screen.",
      <>Enter <code>{server}</code> and continue.</>,
    ];
    case "ios": return [
      "Install or update Tailscale.",
      <>Open the iPhone Settings app → Tailscale → Alternate Coordination Server URL, and enter <code>{server}</code>.</>,
      "Force-quit Tailscale, open it again, and sign in.",
    ];
    case "desktop": return [
      "Install or update Tailscale.",
      <>In a terminal run <code>tailscale login --login-server {server}</code>.</>,
    ];
  }
  return assertNever(platform, "Network join platform");
}

async function readStatus(): Promise<NetworkStatus | null> {
  const response = await fetch(API.network.path(), {
    cache: "no-store", headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000),
  });
  // Deployments without a router-declared network (or older routers) have nothing to join.
  if (!response.ok) return null;
  return await response.json() as NetworkStatus;
}

export function NetworkJoinPrompt() {
  const key = appStorageKey("network-join-snoozed-until");
  const [network, setNetwork] = useState<PrivateNetwork | null>(null);
  const [snoozed, setSnoozed] = useState(() => Number(localStorage.getItem(key) ?? 0) > Date.now());
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const check = useCallback(async () => {
    const status = await readStatus().catch(() => null);
    setNetwork(status?.network && !status.connected ? status.network : null);
  }, []);

  useEffect(() => {
    void check();
    const foreground = () => { void check(); };
    window.addEventListener("pi-app-foreground", foreground);
    window.addEventListener("online", foreground);
    return () => { window.removeEventListener("pi-app-foreground", foreground); window.removeEventListener("online", foreground); };
  }, [check]);

  if (!network || snoozed) return null;
  const platform = joinPlatform(navigator.userAgent, nativePlatform);
  const download = DOWNLOADS[platform];
  const copy = async () => {
    await navigator.clipboard.writeText(network.loginServer).then(() => setCopied(true), () => setCopied(false));
  };
  return <aside className="network-join" aria-label={`Join ${network.name}`}>
    <div className="network-join-summary">
      <span>You're not on <strong>{network.name}</strong> yet. Kenan is moving there.</span>
      <button type="button" className="accent" onClick={() => setOpen(value => !value)} aria-expanded={open}>{open ? "Hide" : "Set up"}</button>
      <button type="button" aria-label="Remind me tomorrow" title="Remind me tomorrow" onClick={() => {
        localStorage.setItem(key, String(Date.now() + SNOOZE_MS));
        setSnoozed(true);
      }}>×</button>
    </div>
    {open && <div className="network-join-steps">
      <a className="network-join-download" href={download.url} target="_blank" rel="noopener noreferrer">{download.label}</a>
      <ol>
        {steps(platform, network.loginServer).map((step, index) => <li key={index}>{step}</li>)}
        <li>Tailscale opens a registration page. Copy the code on it into a Kenan thread and ask Kenan to approve it. Keep the page open until Kenan confirms.</li>
      </ol>
      <button type="button" onClick={() => void copy()}>{copied ? "Copied" : "Copy server address"}</button>
    </div>}
  </aside>;
}
