import { useCallback, useEffect, useRef, useState } from "react";
import { Temporal } from "@js-temporal/polyfill";
import type { CalendarEvent, CalendarSnapshot } from "../../server/calendar-protocol";
import { api } from "./client";
import "./calendar.css";

const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const blank = (zone: string) => {
  const now = Temporal.Now.zonedDateTimeISO(zone).round({ smallestUnit: "hour", roundingMode: "ceil" });
  return { title: "", start: now.toPlainDateTime().toString().slice(0, 16), end: now.add({ hours: 1 }).toPlainDateTime().toString().slice(0, 16), zone, allDay: false, location: "", notes: "" };
};
type Draft = ReturnType<typeof blank> & { id?: string };
function EventEditor({ draft, onClose, onSave }: { draft: Draft; onClose(): void; onSave(draft: Draft): Promise<void> }) {
  const [value, setValue] = useState(draft), [error, setError] = useState(""), [saving, setSaving] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="calendar-dialog" onCancel={onClose}><form onSubmit={async e => { e.preventDefault(); setSaving(true); setError(""); try { await onSave(value); onClose(); } catch (cause) { setError(String(cause)); } finally { setSaving(false); } }}>
    <h2>{value.id ? "Edit event" : "New event"}</h2>
    <label>Title<input required maxLength={500} value={value.title} onChange={e => setValue({ ...value, title: e.target.value })} /></label>
    <label className="calendar-check"><input type="checkbox" checked={value.allDay} onChange={e => { const allDay = e.target.checked; setValue({ ...value, allDay, start: allDay ? value.start.slice(0, 10) : value.start + "T09:00", end: allDay ? Temporal.PlainDate.from(value.start.slice(0, 10)).add({ days: 1 }).toString() : value.end + "T10:00" }); }} />All day</label>
    <label>Start<input required type={value.allDay ? "date" : "datetime-local"} value={value.start} onChange={e => setValue({ ...value, start: e.target.value })} /></label>
    <label>{value.allDay ? "End (exclusive following date)" : "End"}<input required type={value.allDay ? "date" : "datetime-local"} value={value.end} onChange={e => setValue({ ...value, end: e.target.value })} /></label>
    <label>Event time zone<input required value={value.zone} placeholder="America/Los_Angeles" onChange={e => setValue({ ...value, zone: e.target.value })} /></label>
    <label>Location<input value={value.location} onChange={e => setValue({ ...value, location: e.target.value })} /></label>
    <label>Notes<textarea rows={3} value={value.notes} onChange={e => setValue({ ...value, notes: e.target.value })} /></label>
    {error && <p role="alert">{error}</p>}<div className="calendar-actions"><button type="button" onClick={onClose}>Cancel</button><button className="accent" disabled={saving}>Save</button></div>
  </form></dialog>;
}
export function CalendarScreen() {
  const [snapshot, setSnapshot] = useState<CalendarSnapshot | null>(null), [zone, setZone] = useState(localZone), [error, setError] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null), [feed, setFeed] = useState(""), [sync, setSync] = useState(false), [busy, setBusy] = useState(false);
  const [name, setName] = useState(""), [url, setUrl] = useState(""), [month, setMonth] = useState("");
  const reload = useCallback(async () => {
    const from = month ? Temporal.PlainDate.from(month + "-01").toZonedDateTime(zone).toInstant().toString() : new Date().toISOString();
    const to = month ? Temporal.PlainDate.from(month + "-01").add({ months: 1 }).toZonedDateTime(zone).toInstant().toString() : new Date(Date.now() + 180 * 86400000).toISOString();
    const next: CalendarSnapshot = await api("GET", `/v1/calendar?${new URLSearchParams({ from, to })}`); setSnapshot(next);
  }, [month, zone]);
  useEffect(() => {
    let current = true;
    const load = async () => { try { await reload(); if (current) setError(""); } catch (cause) { if (current) setError(String(cause)); } };
    void load(); const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 60000);
    const focus = () => void load(); window.addEventListener("focus", focus);
    return () => { current = false; clearInterval(timer); window.removeEventListener("focus", focus); };
  }, [reload]);
  async function action(work: () => Promise<unknown>) { setBusy(true); setError(""); try { await work(); await reload(); } catch (cause) { setError(String(cause)); } finally { setBusy(false); } }
  function edit(e: CalendarEvent) {
    const wall = (v: string) => e.allDay ? v : Temporal.Instant.from(v).toZonedDateTimeISO(e.zone).toPlainDateTime().toString().slice(0, 16);
    setDraft({ ...e, start: wall(e.start), end: wall(e.end) });
  }
  function when(e: CalendarEvent) {
    if (e.allDay) return `${e.start} · All day${Temporal.PlainDate.from(e.end).since(Temporal.PlainDate.from(e.start)).days > 1 ? ` (through ${Temporal.PlainDate.from(e.end).subtract({ days: 1 })})` : ""}`;
    const format = new Intl.DateTimeFormat(undefined, { timeZone: zone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    return `${format.format(new Date(e.start))} – ${new Intl.DateTimeFormat(undefined, { timeZone: zone, hour: "numeric", minute: "2-digit" }).format(new Date(e.end))}`;
  }
  return <section className="calendar-screen">
    <header className="calendar-actions"><h1>Calendar</h1><button className="accent" onClick={() => setDraft(blank(zone))}>New event</button><button onClick={() => setSync(!sync)}>Sync</button></header>
    <div className="calendar-actions"><label>Display time zone<select value={zone} onChange={e => { setZone(e.target.value); void action(() => api("PUT", "/v1/calendar/settings", { zone: e.target.value })); }}>{[...new Set([localZone(), "UTC", ...Intl.supportedValuesOf("timeZone")])].map(z => <option key={z} value={z}>{z}</option>)}</select></label><label>Month (optional)<input type="month" value={month} onChange={e => setMonth(e.target.value)} /></label><button onClick={() => setMonth("")}>Upcoming</button><button disabled={busy} onClick={() => void action(() => api("POST", "/v1/calendar/refresh", {}, 65000))}>Refresh</button></div>
    {error && <p role="alert">{error}</p>}
    {sync && <section className="calendar-sync"><h2>Calendar sync</h2><p>Subscriptions are read-only. Two-way CalDAV sync is not supported.</p>
      <button disabled={busy} onClick={() => void action(async () => { const r = await api("GET", "/v1/calendar/feed"); setFeed(new URL(r.url, location.origin).href); })}>Show subscription link</button>
      {feed && <><label>Private feed URL<input readOnly value={feed} onFocus={e => e.target.select()} /></label><p>Anyone with this link can read your events. Google Calendar: Other calendars → + → From URL. Refresh timing is controlled by Google. The feed works while your folder is unlocked.</p><button disabled={busy} onClick={() => { if (confirm("Revoke the current link? Existing subscribers will stop receiving updates.")) void action(async () => { const r = await api("POST", "/v1/calendar/feed", {}); setFeed(new URL(r.url, location.origin).href); }); }}>Rotate link</button></>}
      <form onSubmit={e => { e.preventDefault(); void action(async () => { await api("POST", "/v1/calendar/subscriptions", { name, url, zone }, 65000); setName(""); setUrl(""); }); }}><h3>Add an ICS subscription</h3><label>Name<input required value={name} onChange={e => setName(e.target.value)} /></label><label>ICS URL<input required type="url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://…" /></label><p>Floating times use {zone}. Imported events refresh every 15 minutes.</p><button disabled={busy}>Subscribe</button></form>
      {snapshot?.subscriptions.map(s => <article key={s.id}><strong>{s.name}</strong><p>{s.refreshed ? `Updated ${new Date(s.refreshed).toLocaleString()}` : "Not yet refreshed"}{s.error && ` · ${s.error}`}</p><button disabled={busy} onClick={() => { if (confirm(`Remove ${s.name}?`)) void action(() => api("DELETE", `/v1/calendar/subscriptions/${s.id}`)); }}>Remove subscription</button></article>)}
    </section>}
    {!snapshot ? <p>Loading calendar…</p> : !snapshot.events.length ? <p>No events {month ? "this month" : "in the next six months"}.</p> : <div className="calendar-agenda">{snapshot.events.map(e => <article key={e.id}><p className="calendar-time">{when(e)}</p><h2>{e.title}</h2>{e.location && <p>{e.location}</p>}{e.notes && <p className="calendar-notes">{e.notes}</p>}{e.zone !== zone && !e.allDay && <p className="muted">Event zone: {e.zone} · {new Intl.DateTimeFormat(undefined, { timeZone: e.zone, hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(e.start))}</p>}{e.readOnly ? <p className="muted">{e.source} · Read-only</p> : <div className="calendar-actions"><button onClick={() => edit(e)}>Edit</button><button disabled={busy} onClick={() => { if (confirm(`Delete ${e.title}?`)) void action(() => api("DELETE", `/v1/calendar/events/${e.id}`)); }}>Delete</button></div>}</article>)}</div>}
    {draft && <EventEditor draft={draft} onClose={() => setDraft(null)} onSave={async value => { await api(value.id ? "PATCH" : "POST", `/v1/calendar/events${value.id ? `/${value.id}` : ""}`, value); await reload(); }} />}
  </section>;
}
