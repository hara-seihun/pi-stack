import ICAL from "ical.js";
import { Temporal } from "@js-temporal/polyfill";
import { tzlib_get_ical_block } from "timezones-ical-library";
import { calendarOverlaps, ownedOccurrence, eventWallTime } from "./calendar-recurrence.js";
import type { CalendarEvent, CalendarSubscription } from "./calendar-contract.js";
export type CalendarParseResult<T> = { ok: true; value: T } | { ok: false; error: string };
const bad = (error: string): CalendarParseResult<never> => ({ ok: false, error });
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export function validZone(zone: string): boolean { try { new Intl.DateTimeFormat("en", { timeZone: zone }); return true; } catch { return false; } }
export function calendarTime(value: string, zone: string, allDay: boolean): CalendarParseResult<string> {
  try {
    if (allDay) return { ok: true, value: Temporal.PlainDate.from(value).toString() };
    const instant = /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Temporal.Instant.from(value) : Temporal.PlainDateTime.from(value).toZonedDateTime(zone, { disambiguation: "reject" }).toInstant();
    return { ok: true, value: instant.toString() };
  } catch { return bad("Invalid date/time (ambiguous or nonexistent local times require an explicit UTC offset)"); }
}
export function calendarEvent(input: unknown, previous: CalendarEvent | null): CalendarParseResult<CalendarEvent> {
  if (!object(input)) return bad("Expected an event object");
  const fields = new Set(["title", "start", "end", "zone", "allDay", "location", "notes", "repeat", "repeatUntil"]);
  if (Object.keys(input).some(field => !fields.has(field))) return bad("Unknown or immutable event field");
  const value: Record<string, unknown> = { ...(previous === null ? {} : { ...previous, repeat: previous.repeat === undefined ? null : previous.repeat, repeatUntil: previous.repeatUntil === undefined ? null : previous.repeatUntil }), ...input };
  if (typeof value.title !== "string" || !value.title.trim() || value.title.length > 500) return bad("Title is required (maximum 500 characters)");
  if (typeof value.zone !== "string" || !validZone(value.zone)) return bad("Use an explicit IANA time zone");
  if (typeof value.allDay !== "boolean" || typeof value.start !== "string" || typeof value.end !== "string") return bad("Start, end and allDay must be explicit event fields");
  if (typeof value.location !== "string" || value.location.length > 2000 || typeof value.notes !== "string" || value.notes.length > 20000) return bad("Explicit location and notes are required within their size limits");
  const start = calendarTime(value.start, value.zone, value.allDay), end = calendarTime(value.end, value.zone, value.allDay);
  if (!start.ok) return start; if (!end.ok) return end;
  if (value.allDay ? end.value <= start.value : Date.parse(end.value) <= Date.parse(start.value)) return bad("End must be after start; all-day end is exclusive");
  if (value.repeat !== null && value.repeat !== "daily" && value.repeat !== "weekly") return bad("Repeat must be explicit null, daily or weekly");
  if (value.repeatUntil !== null) {
    if (typeof value.repeatUntil !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.repeatUntil)) return bad("Repeat until must be explicit null or YYYY-MM-DD");
    try { Temporal.PlainDate.from(value.repeatUntil); } catch { return bad("Invalid repeat-until date"); }
    const date = value.allDay ? start.value : Temporal.Instant.from(start.value).toZonedDateTimeISO(value.zone).toPlainDate().toString();
    if (value.repeatUntil < date) return bad("Repeat until cannot precede the first event");
  }
  if (value.repeat === null && value.repeatUntil !== null) return bad("A nonrepeating event has no repeat-until date");
  if (value.repeat && !value.allDay && !Array.isArray(tzlib_get_ical_block(value.zone))) return bad("This time zone has no iCalendar recurrence definition");
  return { ok: true, value: { id: previous === null ? crypto.randomUUID() : previous.id, title: value.title.trim(), start: start.value, end: end.value, zone: value.zone, allDay: value.allDay, location: value.location, notes: value.notes, updated: new Date().toISOString(), repeat: value.repeat, repeatUntil: value.repeatUntil as string | null, ...(value.repeat && previous?.exceptions ? { exceptions: previous.exceptions } : {}) } };
}
const textProp = (component: ICAL.Component, key: string): string => String(component.getFirstPropertyValue(key) ?? "");
export function importedEvents(body: string, subscription: Pick<CalendarSubscription, "id" | "name" | "zone">, from: string, to: string): CalendarEvent[] {
  const calendar = new ICAL.Component(ICAL.parse(body));
  if (calendar.name !== "vcalendar") throw new Error("Not an iCalendar");
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
  const events = components.map(component => new ICAL.Event(component));
  const result: CalendarEvent[] = [];
  const lower = Date.parse(from), upper = Date.parse(to);
  const instant = (time: ICAL.Time, zone: string): string => {
    if (time.isDate) return time.toString();
    if (time.zone === ICAL.Timezone.localTimezone) {
      const converted = calendarTime(time.toString(), zone, false);
      if (!converted.ok) throw new Error(converted.error);
      return converted.value;
    }
    return new Date(time.toUnixTime() * 1000).toISOString();
  };
  try {
    for (const event of events.filter(item => !item.isRecurrenceException())) {
      if (textProp(event.component, "status") === "CANCELLED") continue;
      for (const exception of events.filter(item => item.isRecurrenceException() && item.uid === event.uid)) event.relateException(exception);
      const append = (start: ICAL.Time, end: ICAL.Time, item: ICAL.Event) => {
        if (textProp(item.component, "status") === "CANCELLED") return;
        const zoneId = String(item.component.getFirstProperty("dtstart")?.getParameter("tzid") ?? start.zone.tzid).replace(prefix, "");
        const zone = validZone(zoneId) ? zoneId : subscription.zone;
        const value: CalendarEvent = { id: `${subscription.id}:${event.uid}:${start.toString()}`, title: item.summary || "", start: instant(start, zone), end: instant(end, zone), zone, allDay: start.isDate, location: item.location || "", notes: item.description || "", updated: null, readOnly: true, source: subscription.name };
        if (value.allDay ? value.end <= value.start : Date.parse(value.end) <= Date.parse(value.start)) throw new Error("Imported event has no positive duration");
        if (calendarOverlaps(value, from, to)) result.push(value);
      };
      if (!event.isRecurring()) { append(event.startDate, event.endDate, event); continue; }
      const iterator = event.iterator();
      let complete = false;
      for (let count = 0; count < 100000; count++) {
        const occurrence = iterator.next(); if (!occurrence) { complete = true; break; }
        const originalZone = String(event.component.getFirstProperty("dtstart")?.getParameter("tzid") ?? "").replace(prefix, "");
        const value = instant(occurrence, validZone(originalZone) ? originalZone : subscription.zone);
        if (Date.parse(value) >= upper + 86400000) { complete = true; break; }
        if (Date.parse(value) < lower - 366 * 86400000) continue;
        const details = event.getOccurrenceDetails(occurrence); append(details.startDate, details.endDate, details.item);
      }
      if (!complete) throw new Error("Recurrence limit exceeded");
    }
    return result;
  } finally { for (const component of calendar.getAllSubcomponents("vtimezone")) ICAL.TimezoneService.remove(textProp(component, "tzid")); }
}
export function calendarICS(events: CalendarEvent[]): string {
  const calendar = new ICAL.Component(["vcalendar", [], []]);
  calendar.addPropertyWithValue("version", "2.0"); calendar.addPropertyWithValue("prodid", "-//Pi Stack//Memory Calendar//EN"); calendar.addPropertyWithValue("x-wr-calname", "Kenan calendar");
  const zones = new Map<string, string>();
  const recurringTime = (component: ICAL.Component, name: string, event: CalendarEvent, value: string) => {
    component.addPropertyWithValue(name, event.allDay ? ICAL.Time.fromDateString(value) : ICAL.Time.fromDateTimeString(eventWallTime(event, value)));
    if (!event.allDay) component.getFirstProperty(name)!.setParameter("tzid", zones.get(event.zone)!);
  };
  for (const event of events.filter(event => event.repeat && !event.allDay)) {
    if (zones.has(event.zone)) continue;
    const block = tzlib_get_ical_block(event.zone); if (!Array.isArray(block)) throw new Error("Missing recurrence time zone definition");
    const component = new ICAL.Component(ICAL.parse(block[0]!)); zones.set(event.zone, textProp(component, "tzid")); calendar.addSubcomponent(component);
  }
  for (const event of events) {
    const component = new ICAL.Component("vevent"); component.addPropertyWithValue("uid", `${event.id}@pi-stack`); component.addPropertyWithValue("summary", event.title);
    if (event.updated === null || !Number.isFinite(Date.parse(event.updated))) throw new Error("Export requires a known event update timestamp");
    component.addPropertyWithValue("dtstamp", ICAL.Time.fromJSDate(new Date(event.updated), true)); component.addPropertyWithValue("last-modified", ICAL.Time.fromJSDate(new Date(event.updated), true));
    if (event.repeat) {
      recurringTime(component, "dtstart", event, event.start); recurringTime(component, "dtend", event, event.end);
      const until = event.repeatUntil ? event.allDay ? event.repeatUntil.replaceAll("-", "") : Temporal.PlainDate.from(event.repeatUntil).add({ days: 1 }).toZonedDateTime(event.zone).subtract({ seconds: 1 }).toInstant().toString().replaceAll(/[-:]/g, "") : null;
      component.addPropertyWithValue("rrule", ICAL.Recur.fromString(`FREQ=${event.repeat.toUpperCase()}${until ? `;UNTIL=${until}` : ""}`));
      for (const [original, replacement] of Object.entries(event.exceptions ?? {})) {
        if (!ownedOccurrence(event, original)) continue;
        if (!replacement) {
          const exclusion = new ICAL.Property("exdate"); exclusion.setValue(event.allDay ? ICAL.Time.fromDateString(original) : ICAL.Time.fromDateTimeString(eventWallTime(event, original)));
          if (!event.allDay) exclusion.setParameter("tzid", zones.get(event.zone)!); component.addProperty(exclusion);
        } else {
          const exception = new ICAL.Component(new ICAL.Component(ICAL.parse(calendarICS([{ ...replacement, id: event.id, repeat: null }]))).getFirstSubcomponent("vevent")!.toJSON());
          recurringTime(exception, "recurrence-id", event, original); calendar.addSubcomponent(exception);
        }
      }
    } else {
      component.addPropertyWithValue("dtstart", event.allDay ? ICAL.Time.fromDateString(event.start) : ICAL.Time.fromJSDate(new Date(event.start), true));
      component.addPropertyWithValue("dtend", event.allDay ? ICAL.Time.fromDateString(event.end) : ICAL.Time.fromJSDate(new Date(event.end), true));
    }
    component.addPropertyWithValue("location", event.location); component.addPropertyWithValue("description", event.notes); component.addPropertyWithValue("x-pi-timezone", event.zone); calendar.addSubcomponent(component);
  }
  return calendar.toString() + "\r\n";
}
