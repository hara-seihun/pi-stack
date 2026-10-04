import { Temporal } from "@js-temporal/polyfill";
import type { CalendarEvent } from "./calendar-protocol";

export const calendarOverlaps = (e: CalendarEvent, from: string, to: string) => e.allDay ? e.end > from.slice(0, 10) && e.start < to.slice(0, 10) : Date.parse(e.end) > Date.parse(from) && Date.parse(e.start) < Date.parse(to);
const wall = (e: CalendarEvent, value: string) => e.allDay ? Temporal.PlainDate.from(value).toPlainDateTime() : Temporal.Instant.from(value).toZonedDateTimeISO(e.zone).toPlainDateTime();
const step = (e: CalendarEvent) => e.repeat === "weekly" ? 7 : 1;
function atDay(e: CalendarEvent, days: number): CalendarEvent | undefined {
  const start = wall(e, e.start).add({ days }), end = wall(e, e.end).add({ days });
  if (e.repeatUntil && start.toPlainDate().toString() > e.repeatUntil) return;
  const zoned = start.toZonedDateTime(e.zone);
  // RFC 5545 ignores nonexistent recurrence times; ambiguous times use the first occurrence.
  if (!e.allDay && !zoned.toPlainDateTime().equals(start)) return;
  const value = e.allDay ? start.toPlainDate().toString() : days === 0 ? e.start : zoned.toInstant().toString();
  return { ...e, exceptions: undefined, id: `${e.id}~${value}`, seriesId: e.id, occurrenceStart: value, start: value, end: e.allDay ? end.toPlainDate().toString() : days === 0 ? e.end : end.toZonedDateTime(e.zone).toInstant().toString() };
}
export function ownedOccurrence(e: CalendarEvent, value: string): CalendarEvent | undefined {
  if (!e.repeat) return;
  try {
    const days = wall(e, value).toPlainDate().since(wall(e, e.start).toPlainDate(), { largestUnit: "day" }).days;
    if (days < 0 || days % step(e)) return;
    const occurrence = atDay(e, days);
    return occurrence?.start === value ? occurrence : undefined;
  } catch { return; }
}
export function ownedOccurrences(e: CalendarEvent, from: string, to: string): CalendarEvent[] {
  if (!e.repeat) return calendarOverlaps(e, from, to) ? [e] : [];
  const start = wall(e, e.start), end = wall(e, e.end);
  const lower = Temporal.Instant.from(from).toZonedDateTimeISO(e.zone).toPlainDate();
  const upper = Temporal.Instant.from(to).toZonedDateTimeISO(e.zone).toPlainDate().add({ days: 1 });
  const durationDays = end.toPlainDate().since(start.toPlainDate(), { largestUnit: "day" }).days + 1;
  const first = Math.max(0, Math.floor((lower.since(start.toPlainDate(), { largestUnit: "day" }).days - durationDays) / step(e)) * step(e));
  const last = upper.since(start.toPlainDate(), { largestUnit: "day" }).days;
  const result: CalendarEvent[] = [];
  for (let days = first; days <= last; days += step(e)) {
    const occurrence = atDay(e, days);
    if (occurrence && !(occurrence.start in (e.exceptions ?? {})) && calendarOverlaps(occurrence, from, to)) result.push(occurrence);
  }
  for (const [original, replacement] of Object.entries(e.exceptions ?? {})) {
    if (replacement && ownedOccurrence(e, original) && calendarOverlaps(replacement, from, to)) result.push({ ...replacement, repeat: e.repeat, repeatUntil: e.repeatUntil, id: `${e.id}~${original}`, seriesId: e.id, occurrenceStart: original });
  }
  return result;
}
export function eventWallTime(e: CalendarEvent, value: string): string { return wall(e, value).toString().slice(0, 19); }
