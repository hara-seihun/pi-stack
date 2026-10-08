import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Temporal } from "@js-temporal/polyfill";
import type { CalendarEvent, CalendarSnapshot } from "../../server/calendar-protocol";
import { api } from "./client";
import { toast } from "./toasts";
import "./calendar.css";

const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const blank = (zone: string) => {
  const now = Temporal.Now.zonedDateTimeISO(zone).round({ smallestUnit: "hour", roundingMode: "ceil" });
  return { title: "", start: now.toPlainDateTime().toString().slice(0, 16), end: now.add({ hours: 1 }).toPlainDateTime().toString().slice(0, 16), zone, allDay: false, location: "", notes: "" };
};
type Draft = ReturnType<typeof blank> & { id?: string; instantStart?: string; instantEnd?: string; repeat?: CalendarEvent["repeat"]; repeatUntil?: string | null; scope?: "occurrence" | "series" };
function EventEditor({ draft, onClose, onSave }: { draft: Draft; onClose(): void; onSave(draft: Draft): Promise<void> }) {
  const [value, setValue] = useState(draft), [error, setError] = useState(""), [saving, setSaving] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="calendar-dialog" onCancel={onClose}><form onSubmit={async e => { e.preventDefault(); setSaving(true); setError(""); try { await onSave(value); onClose(); } catch (cause) { setError(String(cause)); } finally { setSaving(false); } }}>
    <h2>{value.scope === "occurrence" ? "Edit this occurrence" : value.scope === "series" ? "Edit whole series" : value.id ? "Edit event" : "New event"}</h2>
    {value.scope && <p>{value.scope === "occurrence" ? "Only this occurrence changes. The other repeats stay unchanged." : "Changes apply to the whole series, including past occurrences."}</p>}
    <label>Title<input required maxLength={500} value={value.title} onChange={e => setValue({ ...value, title: e.target.value })} /></label>
    <label className="calendar-check"><input type="checkbox" checked={value.allDay} onChange={e => { const allDay = e.target.checked; setValue({ ...value, allDay, start: allDay ? value.start.slice(0, 10) : value.start + "T09:00", end: allDay ? Temporal.PlainDate.from(value.start.slice(0, 10)).add({ days: 1 }).toString() : value.end + "T10:00" }); }} />All day</label>
    <label>Start<input required type={value.allDay ? "date" : "datetime-local"} value={value.start} onChange={e => setValue({ ...value, start: e.target.value })} /></label>
    <label>{value.allDay ? "End (exclusive following date)" : "End"}<input required type={value.allDay ? "date" : "datetime-local"} value={value.end} onChange={e => setValue({ ...value, end: e.target.value })} /></label>
    <label>Event time zone<input required value={value.zone} placeholder="America/Los_Angeles" onChange={e => setValue({ ...value, zone: e.target.value })} /></label>
    {value.scope !== "occurrence" && <><label>Repeat<select value={value.repeat ?? "none"} onChange={e => setValue({ ...value, repeat: e.target.value === "none" ? null : e.target.value as "daily" | "weekly" })}><option value="none">Does not repeat</option><option value="daily">Daily</option><option value="weekly">Weekly on the start weekday</option></select></label>{value.repeat && <><label>Repeat until (optional)<input type="date" min={value.start.slice(0, 10)} value={value.repeatUntil ?? ""} onChange={e => setValue({ ...value, repeatUntil: e.target.value || null })} /></label><p>Repeats at this local time in the event zone, including after daylight-saving changes. Leave the end blank to repeat indefinitely.</p></>}</>}
    <label>Location<input value={value.location} onChange={e => setValue({ ...value, location: e.target.value })} /></label>
    <label>Notes<textarea rows={3} value={value.notes} onChange={e => setValue({ ...value, notes: e.target.value })} /></label>
    {error && <p role="alert">{error}</p>}<div className="calendar-actions"><button type="button" onClick={onClose}>Cancel</button><button className="accent" disabled={saving}>Save</button></div>
  </form></dialog>;
}
export type CalendarAgenda = {
  events: CalendarEvent[];
  renderEvent(event: CalendarEvent): ReactNode;
  zone: string;
};

export function CalendarScreen({ renderAgenda, refreshVersion }: { renderAgenda?: (agenda: CalendarAgenda) => ReactNode; refreshVersion?: string } = {}) {
  const [snapshot, setSnapshot] = useState<CalendarSnapshot | null>(null), [zone, setZone] = useState(localZone), [error, setError] = useState("");
  const preferenceLoaded = useRef(false);
  const [draft, setDraft] = useState<Draft | null>(null), [feed, setFeed] = useState(""), [sync, setSync] = useState(false), [busy, setBusy] = useState(false);
  const [name, setName] = useState(""), [url, setUrl] = useState(""), [month, setMonth] = useState("");
  const reload = useCallback(async () => {
    const from = month ? Temporal.PlainDate.from(month + "-01").toZonedDateTime(zone).toInstant().toString() : new Date().toISOString();
    const to = month ? Temporal.PlainDate.from(month + "-01").add({ months: 1 }).toZonedDateTime(zone).toInstant().toString() : new Date(Date.now() + 180 * 86400000).toISOString();
    const next: CalendarSnapshot = await api("GET", `/v1/calendar?${new URLSearchParams({ from, to })}`); setSnapshot(next);
    if (!preferenceLoaded.current) { preferenceLoaded.current = true; if (next.zone) setZone(next.zone); }
  }, [month, zone]);
  useEffect(() => {
    let current = true;
    const load = async () => { try { await reload(); if (current) setError(""); } catch (cause) { if (current) setError(String(cause)); } };
    void load(); const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 60000);
    const focus = () => void load(); window.addEventListener("focus", focus);
    return () => { current = false; clearInterval(timer); window.removeEventListener("focus", focus); };
  }, [reload, refreshVersion]);
  async function action(work: () => Promise<unknown>) { setBusy(true); setError(""); try { await work(); await reload(); } catch (cause) { setError(String(cause)); } finally { setBusy(false); } }
  async function remove(path: string) {
    const result = await api("DELETE", path);
    toast("Deleted", { duration: 10000, action: { label: "Undo", onClick: () => void action(() => api("POST", `/v1/calendar/undo/${result.undoToken}`, {})) } });
  }
  function edit(e: CalendarEvent, scope?: "occurrence" | "series") {
    const wall = (v: string) => e.allDay ? v : Temporal.Instant.from(v).toZonedDateTimeISO(e.zone).toPlainDateTime().toString().slice(0, 16);
    setDraft({ ...e, scope, start: wall(e.start), end: wall(e.end), instantStart: e.start, instantEnd: e.end });
  }
  function when(e: CalendarEvent) {
    if (e.allDay) return `${e.start} · All day${Temporal.PlainDate.from(e.end).since(Temporal.PlainDate.from(e.start)).days > 1 ? ` (through ${Temporal.PlainDate.from(e.end).subtract({ days: 1 })})` : ""}`;
    const format = new Intl.DateTimeFormat(undefined, { timeZone: zone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    const sameDay = Temporal.Instant.from(e.start).toZonedDateTimeISO(zone).toPlainDate().equals(Temporal.Instant.from(e.end).toZonedDateTimeISO(zone).toPlainDate());
    return `${format.format(new Date(e.start))} – ${sameDay ? new Intl.DateTimeFormat(undefined, { timeZone: zone, hour: "numeric", minute: "2-digit" }).format(new Date(e.end)) : format.format(new Date(e.end))}`;
  }
  function renderEvent(e: CalendarEvent): ReactNode {
    return <article key={e.id} className="calendar-event"><p className="calendar-time">{when(e)}</p><h2>{e.title}</h2>{e.repeat && <p className="muted">Repeats {e.repeat}{e.repeatUntil ? ` · through ${e.repeatUntil}` : " · no end date"}</p>}{e.location && <p>{e.location}</p>}{e.notes && <p className="calendar-notes">{e.notes}</p>}{e.zone !== zone && !e.allDay && <p className="muted">Event zone: {e.zone} · {new Intl.DateTimeFormat(undefined, { timeZone: e.zone, hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(e.start))}</p>}{e.readOnly ? <p className="muted">{e.source} · Read-only</p> : <div className="calendar-actions"><button onClick={() => edit(e, e.seriesId ? "occurrence" : undefined)}>{e.seriesId ? "Edit this occurrence" : "Edit"}</button>{e.seriesId && <button disabled={busy} onClick={() => void action(async () => edit(await api("GET", `/v1/calendar/events/${encodeURIComponent(e.seriesId!)}`), "series"))}>Edit whole series</button>}<button disabled={busy} onClick={() => { if (confirm(e.seriesId ? `Delete only this occurrence of ${e.title} (${when(e)})? Other repeats will stay.` : `Delete ${e.title}?`)) void action(() => remove(`/v1/calendar/events/${encodeURIComponent(e.id)}`)); }}>{e.seriesId ? "Delete this occurrence" : "Delete"}</button>{e.seriesId && <button disabled={busy} onClick={() => { if (confirm(`Delete the ENTIRE repeating series “${e.title}”, including all past and future occurrences? This is not just ${when(e)}.`)) void action(() => remove(`/v1/calendar/events/${encodeURIComponent(e.seriesId!)}?scope=series`)); }}>Delete whole series…</button>}</div>}</article>;
  }
  return <section className={`calendar-screen${renderAgenda ? " calendar-embedded" : ""}`}>
    <header className="calendar-actions">{!renderAgenda && <h1>Calendar</h1>}<button className="accent" onClick={() => setDraft(blank(zone))}>New event</button><button onClick={() => setSync(!sync)}>Sync</button></header>
    <div className="calendar-actions"><label>Display time zone<select value={zone} onChange={e => { setZone(e.target.value); void action(() => api("PUT", "/v1/calendar/settings", { zone: e.target.value })); }}>{[...new Set([localZone(), "UTC", ...Intl.supportedValuesOf("timeZone")])].map(z => <option key={z} value={z}>{z}</option>)}</select></label><label>Month (optional)<input type="month" value={month} onChange={e => setMonth(e.target.value)} /></label><button onClick={() => setMonth("")}>Upcoming</button><button disabled={busy} onClick={() => void action(() => api("POST", "/v1/calendar/refresh", {}, 65000))}>Refresh calendars</button></div>
    {error && <p role="alert">{error}</p>}
    {sync && <section className="calendar-sync"><h2>Calendar sync</h2><p>Subscriptions are read-only. Two-way CalDAV sync is not supported.</p>
      <button disabled={busy} onClick={() => void action(async () => { const r = await api("GET", "/v1/calendar/feed"); setFeed(new URL(r.url, location.origin).href); })}>Show subscription link</button>
      {feed && <><label>Private feed URL<input readOnly value={feed} onFocus={e => e.target.select()} /></label><p>Anyone with this link can read your events. Google Calendar: Other calendars → + → From URL. Refresh timing is controlled by Google. The feed works while your folder is unlocked.</p><button disabled={busy} onClick={() => { if (confirm("Revoke the current link? Existing subscribers will stop receiving updates.")) void action(async () => { const r = await api("POST", "/v1/calendar/feed", {}); setFeed(new URL(r.url, location.origin).href); }); }}>Rotate link</button></>}
      <form onSubmit={e => { e.preventDefault(); void action(async () => { await api("POST", "/v1/calendar/subscriptions", { name, url, zone }, 65000); setName(""); setUrl(""); }); }}><h3>Add an ICS subscription</h3><label>Name<input required value={name} onChange={e => setName(e.target.value)} /></label><label>ICS URL<input required type="url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://…" /></label><p>Floating times use {zone}. Imported events refresh every 15 minutes.</p><button disabled={busy}>Subscribe</button></form>
      {snapshot?.subscriptions.map(s => <article key={s.id}><strong>{s.name}</strong><p>{s.refreshed ? `Updated ${new Date(s.refreshed).toLocaleString()}` : "Not yet refreshed"}{s.error && ` · ${s.error}`}</p><button disabled={busy} onClick={() => { if (confirm(`Remove ${s.name}?`)) void action(() => api("DELETE", `/v1/calendar/subscriptions/${s.id}`)); }}>Remove subscription</button></article>)}
    </section>}
    {!snapshot && !error && <p role="status">Loading calendar…</p>}
    {renderAgenda ? renderAgenda({ events: snapshot ? snapshot.events : [], renderEvent, zone }) : snapshot && (!snapshot.events.length ? <p>No events {month ? "this month" : "in the next six months"}.</p> : <div className="calendar-agenda">{snapshot.events.map(renderEvent)}</div>)}
    {draft && <EventEditor draft={draft} onClose={() => setDraft(null)} onSave={async value => { await api(value.id ? "PATCH" : "POST", `/v1/calendar/events${value.id ? `/${encodeURIComponent(value.id)}${value.scope ? `?scope=${value.scope}` : ""}` : ""}`, { ...value, start: value.start === draft.start && value.zone === draft.zone && value.allDay === draft.allDay ? draft.instantStart ?? value.start : value.start, end: value.end === draft.end && value.zone === draft.zone && value.allDay === draft.allDay ? draft.instantEnd ?? value.end : value.end }); await reload(); }} />}
  </section>;
}
