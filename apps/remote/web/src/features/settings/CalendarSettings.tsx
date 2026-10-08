import { useEffect, useRef, useState } from "react";
import type { CalendarSnapshot } from "../../../../server/calendar-protocol";
import { api } from "../../client";

type CalendarState = { state: "loading" } | { state: "ready"; value: CalendarSnapshot } | { state: "error"; message: string };
const message = (failure: unknown) => failure instanceof Error ? failure.message : String(failure);

async function readCalendarSettings(): Promise<CalendarSnapshot> {
  const now = Date.now();
  return api("GET", `/v1/calendar?${new URLSearchParams({ from: new Date(now).toISOString(), to: new Date(now + 1).toISOString() })}`);
}

export function CalendarSettings({ refreshVersion }: { refreshVersion: string }) {
  const [resource, setResource] = useState<CalendarState>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [feed, setFeed] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const mounted = useRef(false);
  const request = useRef(0);
  const running = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current++; }; }, []);
  useEffect(() => {
    const current = ++request.current;
    setResource({ state: "loading" });
    void readCalendarSettings().then(value => {
      if (mounted.current && current === request.current) setResource({ state: "ready", value });
    }).catch(failure => {
      if (mounted.current && current === request.current) setResource({ state: "error", message: message(failure) });
    });
  }, [refreshVersion, attempt]);

  const action = async (key: string, operation: () => Promise<void>) => {
    if (running.current) return;
    running.current = true; setBusy(key); setError("");
    try { await operation(); }
    catch (failure) { if (mounted.current) setError(message(failure)); }
    finally { running.current = false; if (mounted.current) setBusy(null); }
  };
  const reload = async () => {
    const current = ++request.current;
    const value = await readCalendarSettings();
    if (mounted.current && current === request.current) setResource({ state: "ready", value });
  };
  const showFeed = async (rotate: boolean) => {
    const result = await api(rotate ? "POST" : "GET", "/v1/calendar/feed", rotate ? {} : undefined);
    if (typeof result.url !== "string" || !result.url) throw new Error("Calendar did not return a private feed link.");
    const link = new URL(result.url, location.origin);
    if (link.protocol !== "http:" && link.protocol !== "https:") throw new Error("Calendar returned an invalid feed link.");
    if (mounted.current) setFeed(link.href);
  };
  const snapshot = resource.state === "ready" ? resource.value : null;
  const zone = snapshot?.zone;
  const zoneAvailable = typeof zone === "string" && zone !== "";
  return <div className="settings-calendar">
    <p className="settings-detail">ICS subscriptions are read-only. Imported events refresh every 15 minutes.</p>
    {resource.state === "loading" && <p role="status">Loading calendar subscriptions…</p>}
    {resource.state === "error" && <div><p role="alert">{resource.message}</p><button type="button" disabled={busy !== null} onClick={() => setAttempt(value => value + 1)}>Retry subscriptions</button></div>}
    {snapshot?.settingsError && <p role="alert">{snapshot.settingsError}</p>}
    {snapshot && <>
      <button type="button" disabled={busy !== null} onClick={() => void action("refresh", async () => { await api("POST", "/v1/calendar/refresh", {}, 55_000); if (mounted.current) await reload(); })}>{busy === "refresh" ? "Refreshing…" : "Refresh calendars"}</button>
      {snapshot.subscriptions.length === 0 ? <p>No calendar subscriptions.</p> : <ul className="settings-subscriptions">{snapshot.subscriptions.map(subscription => <li key={subscription.id}><div><strong>{subscription.name}</strong><p className="settings-detail">Floating times: {subscription.zone}</p><p>{subscription.refreshed ? `Updated ${new Date(subscription.refreshed).toLocaleString()}` : "Not yet refreshed"}</p>{subscription.error && <p role="alert">{subscription.error}</p>}</div><button type="button" disabled={busy !== null} onClick={() => {
        if (!confirm(`Remove the calendar subscription “${subscription.name}”? Its imported events will disappear.`)) return;
        void action(`remove:${subscription.id}`, async () => { await api("DELETE", `/v1/calendar/subscriptions/${encodeURIComponent(subscription.id)}`); if (mounted.current) await reload(); });
      }}>Remove subscription</button></li>)}</ul>}
    </>}
    <form className="settings-calendar-form" onSubmit={event => {
      event.preventDefault();
      if (!zoneAvailable) return;
      void action("subscribe", async () => {
        await api("POST", "/v1/calendar/subscriptions", { name: name.trim(), url: url.trim(), zone }, 55_000);
        if (!mounted.current) return;
        setName(""); setUrl(""); await reload();
      });
    }}><h3>Add an ICS subscription</h3><label>Name<input required maxLength={200} value={name} disabled={busy !== null} onChange={event => setName(event.target.value)} /></label><label>ICS URL<input required type="url" value={url} disabled={busy !== null} onChange={event => setUrl(event.target.value)} placeholder="https://…" /></label>
      <p className="settings-detail">{zoneAvailable ? `Floating times use your timezone: ${zone}.` : "Set your timezone above before subscribing."}</p><button disabled={busy !== null || !zoneAvailable || !name.trim() || !url.trim()}>{busy === "subscribe" ? "Subscribing…" : "Subscribe"}</button>
    </form>
    <div className="settings-calendar-feed"><h3>Private calendar feed</h3><p className="settings-detail">Subscribe from another calendar application. Anyone with the link can read your events while your folder is unlocked.</p>
      <button type="button" disabled={busy !== null} onClick={() => void action("feed", () => showFeed(false))}>{busy === "feed" ? "Loading link…" : "Show subscription link"}</button>
      {feed && <><label>Private feed URL<input readOnly value={feed} onFocus={event => event.target.select()} /></label><p className="settings-detail">Google Calendar: Other calendars → + → From URL. Your calendar application controls refresh timing.</p><button type="button" disabled={busy !== null} onClick={() => {
        if (!confirm("Revoke the current feed link? Existing subscribers will stop receiving updates.")) return;
        void action("rotate", () => showFeed(true));
      }}>Rotate private link</button></>}
    </div>
    {error && <p role="alert">{error}</p>}
  </div>;
}
