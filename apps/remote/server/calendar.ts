import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import ICAL from "ical.js";
import { Temporal } from "@js-temporal/polyfill";
import { tzlib_get_ical_block } from "timezones-ical-library";
import { calendarOverlaps as overlaps, ownedOccurrences, ownedOccurrence, eventWallTime } from "./calendar-recurrence";

import type { CalendarEvent, CalendarSubscription, CalendarSnapshot } from "./calendar-protocol";
export type { CalendarEvent, CalendarSubscription, CalendarSnapshot } from "./calendar-protocol";
type Result<T> = { ok: true; value: T } | { ok: false; error: string };
const bad = (error: string): Result<never> => ({ ok: false, error });
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export function validZone(zone: string): boolean { try { new Intl.DateTimeFormat("en", { timeZone: zone }); return true; } catch { return false; } }
export function calendarTime(value: string, zone: string, allDay = false): Result<string> {
  try {
    if (allDay) return { ok: true, value: Temporal.PlainDate.from(value).toString() };
    const instant = /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Temporal.Instant.from(value) : Temporal.PlainDateTime.from(value).toZonedDateTime(zone, { disambiguation: "reject" }).toInstant();
    return { ok: true, value: instant.toString() };
  } catch { return bad("Invalid date/time (ambiguous or nonexistent local times require an explicit UTC offset)"); }
}
export function calendarEvent(input: unknown, previous?: CalendarEvent): Result<CalendarEvent> {
  if (!object(input)) return bad("Expected an event object");
  const v: Record<string, unknown> = { zone: "UTC", allDay: false, location: "", notes: "", ...previous, ...input };
  if (typeof v.title !== "string" || !v.title.trim() || v.title.length > 500) return bad("Title is required (maximum 500 characters)");
  if (typeof v.zone !== "string" || !validZone(v.zone)) return bad("Use an IANA time zone, such as America/Los_Angeles");
  if (typeof v.allDay !== "boolean" || typeof v.start !== "string" || typeof v.end !== "string") return bad("Start, end and allDay must be valid event fields");
  if (typeof v.location !== "string" || v.location.length > 2000 || typeof v.notes !== "string" || v.notes.length > 20000) return bad("Location or notes are too long");
  const start = calendarTime(v.start, v.zone, v.allDay), end = calendarTime(v.end, v.zone, v.allDay);
  if (!start.ok) return start; if (!end.ok) return end;
  if (v.allDay ? end.value <= start.value : Date.parse(end.value) <= Date.parse(start.value)) return bad("End must be after start; all-day end is the exclusive following date");
  const repeat = v.repeat === "none" ? null : v.repeat ?? null;
  if (repeat !== null && repeat !== "daily" && repeat !== "weekly") return bad("Repeat must be daily, weekly or none");
  const repeatUntil = v.repeatUntil === "none" ? null : v.repeatUntil ?? null;
  if (repeatUntil !== null) {
    if (typeof repeatUntil !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(repeatUntil)) return bad("Repeat until must be a YYYY-MM-DD date or none");
    try { Temporal.PlainDate.from(repeatUntil); } catch { return bad("Invalid repeat-until date"); }
    const startDate = v.allDay ? start.value : Temporal.Instant.from(start.value).toZonedDateTimeISO(v.zone).toPlainDate().toString();
    if (repeatUntil < startDate) return bad("Repeat until cannot precede the first event");
  }
  if (repeat && !v.allDay && !Array.isArray(tzlib_get_ical_block(v.zone))) return bad("This time zone has no iCalendar recurrence definition");
  return { ok: true, value: { id: previous?.id ?? crypto.randomUUID(), title: v.title.trim(), start: start.value, end: end.value, zone: v.zone, allDay: v.allDay, location: v.location, notes: v.notes, updated: new Date().toISOString(), repeat, repeatUntil: repeat ? repeatUntil : null, ...(repeat && previous?.exceptions ? { exceptions: previous.exceptions } : {}) } };
}
function textProp(c: ICAL.Component, key: string): string { return String(c.getFirstPropertyValue(key) ?? ""); }
export function importedEvents(body: string, subscription: Pick<CalendarSubscription, "id" | "name" | "zone">, from: string, to: string): CalendarEvent[] {
  const calendar = new ICAL.Component(ICAL.parse(body));
  if (calendar.name !== "vcalendar") throw new Error("Not an iCalendar");
  // The service registry is global in ical.js. Give each subscription's zones
  // private identifiers so two feeds using different VTIMEZONEs cannot collide.
  const prefix = `pi-${subscription.id}-`;
  for (const component of calendar.getAllSubcomponents("vtimezone")) {
    const id = textProp(component, "tzid");
    component.updatePropertyWithValue("tzid", prefix + id);
    ICAL.TimezoneService.register(new ICAL.Timezone({ component }), prefix + id);
  }
  const components = calendar.getAllSubcomponents("vevent");
  for (const component of components) for (const prop of component.getAllProperties()) {
    const tzid = prop.getParameter("tzid");
    if (typeof tzid === "string" && ICAL.TimezoneService.has(prefix + tzid)) prop.setParameter("tzid", prefix + tzid);
  }
  const events = components.map(c => new ICAL.Event(c));
  const result: CalendarEvent[] = [];
  const lower = Date.parse(from), upper = Date.parse(to);
  const instant = (time: ICAL.Time, zone = subscription.zone): string => {
    if (time.isDate) return time.toString();
    if (time.zone === ICAL.Timezone.localTimezone) {
      const converted = calendarTime(time.toString(), zone);
      if (!converted.ok) throw new Error(converted.error);
      return converted.value;
    }
    return new Date(time.toUnixTime() * 1000).toISOString();
  };
  try {
    for (const event of events.filter(e => !e.isRecurrenceException())) {
      if (textProp(event.component, "status") === "CANCELLED") continue;
      for (const exception of events.filter(e => e.isRecurrenceException() && e.uid === event.uid)) event.relateException(exception);
      const append = (start: ICAL.Time, end: ICAL.Time, item: ICAL.Event) => {
        if (textProp(item.component, "status") === "CANCELLED") return;
        const zoneId = String(item.component.getFirstProperty("dtstart")?.getParameter("tzid") ?? start.zone.tzid).replace(prefix, "");
        const zone = validZone(zoneId) ? zoneId : subscription.zone;
        const e: CalendarEvent = { id: `${subscription.id}:${event.uid}:${start.toString()}`, title: item.summary || "Untitled event", start: instant(start, zone), end: instant(end, zone), zone, allDay: start.isDate, location: item.location || "", notes: item.description || "", updated: "", readOnly: true, source: subscription.name };
        if (e.allDay ? e.end <= e.start : Date.parse(e.end) <= Date.parse(e.start)) e.end = e.allDay ? Temporal.PlainDate.from(e.start).add({ days: 1 }).toString() : new Date(Date.parse(e.start) + 3600000).toISOString();
        if (overlaps(e, from, to)) result.push(e);
      };
      if (!event.isRecurring()) { append(event.startDate, event.endDate, event); continue; }
      const iterator = event.iterator();
      let complete = false;
      for (let n = 0; n < 100000; n++) {
        const occurrence = iterator.next(); if (!occurrence) { complete = true; break; }
        const originalZone = String(event.component.getFirstProperty("dtstart")?.getParameter("tzid") ?? "").replace(prefix, "");
        const value = instant(occurrence, validZone(originalZone) ? originalZone : subscription.zone);
        if (Date.parse(value) >= upper + 86400000) { complete = true; break; }
        if (Date.parse(value) < lower - 366 * 86400000) continue;
        const details = event.getOccurrenceDetails(occurrence);
        append(details.startDate, details.endDate, details.item);
      }
      if (!complete) throw new Error("Recurrence limit exceeded");
    }
    return result;
  } finally {
    for (const component of calendar.getAllSubcomponents("vtimezone")) ICAL.TimezoneService.remove(textProp(component, "tzid"));
  }
}
export function calendarICS(events: CalendarEvent[]): string {
  const calendar = new ICAL.Component(["vcalendar", [], []]);
  calendar.addPropertyWithValue("version", "2.0"); calendar.addPropertyWithValue("prodid", "-//Pi Stack//Personal Calendar//EN");
  calendar.addPropertyWithValue("x-wr-calname", "Kenan calendar");
  const zones = new Map<string, string>();
  const recurringTime = (component: ICAL.Component, name: string, event: CalendarEvent, value: string) => {
    component.addPropertyWithValue(name, event.allDay ? ICAL.Time.fromDateString(value) : ICAL.Time.fromDateTimeString(eventWallTime(event, value)));
    if (!event.allDay) component.getFirstProperty(name)!.setParameter("tzid", zones.get(event.zone)!);
  };
  for (const event of events.filter(e => e.repeat && !e.allDay)) {
    if (zones.has(event.zone)) continue;
    const block = tzlib_get_ical_block(event.zone);
    if (!Array.isArray(block)) throw new Error("Missing recurrence time zone definition");
    const component = new ICAL.Component(ICAL.parse(block[0]!));
    zones.set(event.zone, textProp(component, "tzid")); calendar.addSubcomponent(component);
  }
  for (const event of events) {
    const component = new ICAL.Component("vevent");
    component.addPropertyWithValue("uid", `${event.id}@pi-stack`);
    component.addPropertyWithValue("summary", event.title);
    component.addPropertyWithValue("dtstamp", ICAL.Time.fromJSDate(new Date(event.updated), true));
    component.addPropertyWithValue("last-modified", ICAL.Time.fromJSDate(new Date(event.updated), true));
    if (event.repeat) {
      recurringTime(component, "dtstart", event, event.start); recurringTime(component, "dtend", event, event.end);
      const until = event.repeatUntil ? event.allDay ? event.repeatUntil.replaceAll("-", "") : Temporal.PlainDate.from(event.repeatUntil).add({ days: 1 }).toZonedDateTime(event.zone).subtract({ seconds: 1 }).toInstant().toString().replaceAll(/[-:]/g, "") : null;
      component.addPropertyWithValue("rrule", ICAL.Recur.fromString(`FREQ=${event.repeat.toUpperCase()}${until ? `;UNTIL=${until}` : ""}`));
      for (const [original, replacement] of Object.entries(event.exceptions ?? {})) {
        if (!ownedOccurrence(event, original)) continue;
        if (!replacement) {
          const exclusion = new ICAL.Property("exdate");
          exclusion.setValue(event.allDay ? ICAL.Time.fromDateString(original) : ICAL.Time.fromDateTimeString(eventWallTime(event, original)));
          if (!event.allDay) exclusion.setParameter("tzid", zones.get(event.zone)!);
          component.addProperty(exclusion);
        } else {
          const exception = new ICAL.Component(new ICAL.Component(ICAL.parse(calendarICS([{ ...replacement, id: event.id, repeat: null }]))).getFirstSubcomponent("vevent")!.toJSON());
          recurringTime(exception, "recurrence-id", event, original); calendar.addSubcomponent(exception);
        }
      }
    } else {
      component.addPropertyWithValue("dtstart", event.allDay ? ICAL.Time.fromDateString(event.start) : ICAL.Time.fromJSDate(new Date(event.start), true));
      component.addPropertyWithValue("dtend", event.allDay ? ICAL.Time.fromDateString(event.end) : ICAL.Time.fromJSDate(new Date(event.end), true));
    }
    component.addPropertyWithValue("location", event.location); component.addPropertyWithValue("description", event.notes);
    component.addPropertyWithValue("x-pi-timezone", event.zone);
    calendar.addSubcomponent(component);
  }
  return calendar.toString() + "\r\n";
}

export class CalendarStore {
  private db: Database;
  private timer?: ReturnType<typeof setInterval>;
  private refreshing?: Promise<void>;
  private controller = new AbortController();
  constructor(directory: string, private readonly user: string, private readonly feedBase = "") {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, "calendar.sqlite3");
    this.db = new Database(path, { create: true }); chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS subscriptions(id TEXT PRIMARY KEY, body TEXT NOT NULL, ics TEXT); CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS delete_undo(token TEXT PRIMARY KEY, before TEXT NOT NULL, after TEXT, expires INTEGER NOT NULL)");
  }
  start() { void this.refresh(); this.timer = setInterval(() => void this.refresh(), 15 * 60 * 1000); this.timer.unref(); }
  async close() { if (this.timer) clearInterval(this.timer); this.controller.abort(); await this.refreshing; this.db.close(); }
  private setting(key: string, initial: string): string { this.db.query("INSERT OR IGNORE INTO settings VALUES (?,?)").run(key, initial); return (this.db.query("SELECT value FROM settings WHERE key=?").get(key) as { value: string }).value; }
  private putSetting(key: string, value: string) { this.db.query("INSERT OR REPLACE INTO settings VALUES (?,?)").run(key, value); }
  ownEvents(): CalendarEvent[] { return (this.db.query("SELECT body FROM events").all() as { body: string }[]).map(r => JSON.parse(r.body)); }
  subscriptions(): CalendarSubscription[] { return (this.db.query("SELECT body FROM subscriptions").all() as { body: string }[]).map(r => JSON.parse(r.body)); }
  private saveSubscription(s: CalendarSubscription, ics?: string) {
    if (ics === undefined) this.db.query("UPDATE subscriptions SET body=? WHERE id=?").run(JSON.stringify(s), s.id);
    else this.db.query("INSERT OR REPLACE INTO subscriptions VALUES (?,?,?)").run(s.id, JSON.stringify(s), ics);
  }
  snapshot(from: string, to: string): CalendarSnapshot {
    const subscriptions = this.subscriptions();
    const events = this.ownEvents().flatMap(e => ownedOccurrences(e, from, to));
    for (const subscription of subscriptions) {
      const row = this.db.query("SELECT ics FROM subscriptions WHERE id=?").get(subscription.id) as { ics: string | null };
      if (!row.ics) continue;
      try { events.push(...importedEvents(row.ics, subscription, from, to)); }
      catch { subscription.error = "Calendar could not be expanded in this date range"; }
    }
    return { events: events.sort((a, b) => a.start.localeCompare(b.start)), subscriptions, zone: this.setting("zone", "") };
  }
  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = Promise.all(this.subscriptions().map(async subscription => {
      let body: string;
      try {
        const response = await fetch(subscription.url, { signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(20000)]), headers: { accept: "text/calendar" } });
        if (!response.ok) throw new Error("Calendar fetch failed");
        const reader = response.body?.getReader(); if (!reader) throw new Error("Empty calendar");
        let bytes = 0; const chunks: Uint8Array[] = [];
        try { for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.length; if (bytes > 4 * 1024 * 1024) throw new Error("Calendar too large"); chunks.push(next.value); } }
        finally { await reader.cancel(); }
        body = Buffer.concat(chunks).toString("utf8");
        importedEvents(body, subscription, new Date().toISOString(), new Date(Date.now() + 366 * 86400000).toISOString());
      } catch {
        if (this.controller.signal.aborted) return;
        subscription.error = "Refresh failed; showing the last successful copy (check the subscription URL)";
        this.saveSubscription(subscription); return;
      }
      // A subscription may have been deleted while its request was in flight.
      if (!this.db.query("SELECT id FROM subscriptions WHERE id=?").get(subscription.id)) return;
      this.saveSubscription({ ...subscription, error: null, refreshed: new Date().toISOString() }, body);
    })).then(() => undefined).finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url); const path = url.pathname.replace(/^\/v1\/calendar/, "");
    const fail = (message: string, status = 400) => Response.json({ error: message }, { status });
    if (path.startsWith("/feed/")) {
      const token = path.slice(6), stored = this.db.query("SELECT value FROM settings WHERE key='feed'").get() as { value: string } | null;
      if (req.method !== "GET" || !stored || token.length !== stored.value.length || !timingSafeEqual(Buffer.from(token), Buffer.from(stored.value))) return fail("Not found", 404);
      return new Response(calendarICS(this.ownEvents()), { headers: { "content-type": "text/calendar; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" } });
    }
    let input: unknown = null;
    if (["POST", "PATCH", "PUT"].includes(req.method)) { if (Number(req.headers.get("content-length")) > 64000) return fail("Request too large", 413); try { const text = await req.text(); if (text.length > 64000) return fail("Request too large", 413); input = JSON.parse(text); } catch { return fail("Expected JSON"); } }
    if (path === "" && req.method === "GET") {
      const from = calendarTime(url.searchParams.get("from") ?? new Date().toISOString(), "UTC");
      const to = calendarTime(url.searchParams.get("to") ?? new Date(Date.now() + 180 * 86400000).toISOString(), "UTC");
      if (!from.ok || !to.ok || Date.parse(to.value) <= Date.parse(from.value) || Date.parse(to.value) - Date.parse(from.value) > 2 * 366 * 86400000) return fail("Use a valid date range of at most two years");
      return Response.json(this.snapshot(from.value, to.value));
    }
    const save = (event: CalendarEvent) => this.db.query("INSERT OR REPLACE INTO events VALUES (?,?)").run(event.id, JSON.stringify(event));
    const deleteWithUndo = (before: CalendarEvent, after?: CalendarEvent) => {
      const token = crypto.randomUUID();
      this.db.transaction(() => {
        this.db.query("DELETE FROM delete_undo WHERE expires<?").run(Date.now());
        this.db.query("INSERT INTO delete_undo VALUES (?,?,?,?)").run(token, JSON.stringify(before), after ? JSON.stringify(after) : null, Date.now() + 600000);
        if (after) save(after); else this.db.query("DELETE FROM events WHERE id=?").run(before.id);
      })();
      return token;
    };
    if (path.startsWith("/undo/") && req.method === "POST") {
      const undo = this.db.query("SELECT before, after, expires FROM delete_undo WHERE token=?").get(path.slice(6)) as { before: string; after: string | null; expires: number } | null;
      if (!undo || undo.expires < Date.now()) return fail("Undo has expired", 404);
      const before: CalendarEvent = JSON.parse(undo.before);
      const current = this.db.query("SELECT body FROM events WHERE id=?").get(before.id) as { body: string } | null;
      if ((current?.body ?? null) !== undo.after) return fail("The event changed after deletion; undo would overwrite those changes", 409);
      this.db.transaction(() => { save(before); this.db.query("DELETE FROM delete_undo WHERE token=?").run(path.slice(6)); })();
      return Response.json({ ok: true });
    }
    if (path === "/events" && req.method === "POST") {
      const parsed = calendarEvent(input); if (!parsed.ok) return fail(parsed.error);
      save(parsed.value); return Response.json(parsed.value);
    }
    if (path.startsWith("/events/")) {
      const [id, occurrenceId] = decodeURIComponent(path.slice(8)).split("~");
      const previous = this.ownEvents().find(e => e.id === id);
      if (!previous) return fail("Event not found (imported events are read-only)", 404);
      if (req.method === "GET") return Response.json(previous);
      if (!["PATCH", "DELETE"].includes(req.method)) return fail("Not found", 404);
      const scope = url.searchParams.get("scope") ?? (occurrenceId ? "occurrence" : null);
      if (scope !== null && scope !== "occurrence" && scope !== "series") return fail("Scope must be occurrence or series");
      if (previous.repeat && !scope) return fail("Repeating events require an explicit occurrence or series scope");
      if (scope === "occurrence") {
        const original = occurrenceId ?? url.searchParams.get("occurrence") ?? "";
        const occurrence = ownedOccurrence(previous, original);
        if (!occurrence) return fail("Occurrence not found", 404);
        const existing = previous.exceptions?.[original];
        if (existing === null && req.method === "DELETE") return fail("Occurrence already deleted", 404);
        if (req.method === "PATCH" && !object(input)) return fail("Expected an event object");
        const parsed = req.method === "PATCH" ? calendarEvent({ ...(object(input) ? input : {}), repeat: null, repeatUntil: null }, existing ?? occurrence) : null;
        if (parsed && !parsed.ok) return fail(parsed.error);
        if (parsed?.ok && parsed.value.allDay !== previous.allDay) return fail("Change all-day type on the whole series, not one occurrence");
        const replacement = parsed?.ok ? parsed.value : null;
        const after = { ...previous, updated: new Date().toISOString(), exceptions: { ...previous.exceptions, [original]: replacement } };
        if (replacement) { save(after); return Response.json({ ...replacement, seriesId: id, occurrenceStart: original }); }
        return Response.json({ ok: true, scope: "occurrence", undoToken: deleteWithUndo(previous, after) });
      }
      if (req.method === "DELETE") return Response.json({ ok: true, scope: "series", undoToken: deleteWithUndo(previous) });
      const parsed = calendarEvent(input, previous); if (!parsed.ok) return fail(parsed.error);
      save(parsed.value); return Response.json(parsed.value);
    }
    if (path === "/settings" && req.method === "PUT") { if (!object(input) || typeof input.zone !== "string" || !validZone(input.zone)) return fail("Invalid time zone"); this.putSetting("zone", input.zone); return Response.json({ zone: input.zone }); }
    if (path === "/feed" && ["GET", "POST"].includes(req.method)) {
      if (req.method === "POST") this.putSetting("feed", randomBytes(32).toString("hex"));
      const token = this.setting("feed", randomBytes(32).toString("hex"));
      return Response.json({ url: `${this.feedBase}/calendar-feed/${encodeURIComponent(this.user)}/${token}.ics` });
    }
    if (path === "/subscriptions" && req.method === "POST") {
      if (!object(input) || typeof input.name !== "string" || !input.name.trim() || input.name.length > 200 || typeof input.url !== "string" || input.url.length > 8000) return fail("Subscription name and HTTP(S) URL are required");
      let source: URL; try { source = new URL(input.url.replace(/^webcal:/, "https:")); } catch { return fail("Invalid subscription URL"); }
      if (!["https:", "http:"].includes(source.protocol) || source.username || source.password) return fail("Use HTTP(S) without embedded user/password");
      const zone = typeof input.zone === "string" ? input.zone : this.setting("zone", "") || "UTC"; if (!validZone(zone)) return fail("Invalid time zone");
      const s: CalendarSubscription = { id: crypto.randomUUID(), name: input.name.trim(), url: source.href, zone, refreshed: null, error: null };
      this.saveSubscription(s, ""); await this.refresh(); return Response.json(this.subscriptions().find(item => item.id === s.id));
    }
    if (path.startsWith("/subscriptions/") && req.method === "DELETE") { const r = this.db.query("DELETE FROM subscriptions WHERE id=?").run(path.slice(15)); return r.changes ? Response.json({ ok: true }) : fail("Subscription not found", 404); }
    if (path === "/refresh" && req.method === "POST") { await this.refresh(); return Response.json({ subscriptions: this.subscriptions() }); }
    return fail("Not found", 404);
  }
}
