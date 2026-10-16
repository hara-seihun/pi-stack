import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import ICAL from "ical.js";
import { calendarEvent, calendarICS, importedEvents } from "../src/calendar-format.js";
import { CalendarMemory, parseCalendarCommand } from "../src/calendar-data.js";
import { ownedOccurrences } from "../src/calendar-recurrence.js";
import type { CalendarEvent } from "../src/calendar-contract.js";
const range = ["2026-10-01T00:00:00Z", "2026-12-01T00:00:00Z"] as const;
const event = { title: "Appointment, with punctuation; and\na second line", start: "2026-10-08T16:30", end: "2026-10-08T17:30", zone: "America/Los_Angeles", allDay: false, repeat: null, repeatUntil: null, notes: "private", location: "Online" };
const ics = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:weekly\r\nSUMMARY:Weekly\r\nDTSTART;TZID=America/Toronto:20261025T193000\r\nDTEND;TZID=America/Toronto:20261025T203000\r\nRRULE:FREQ=WEEKLY;COUNT=3\r\nEXDATE;TZID=America/Toronto:20261101T193000\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:weekly\r\nRECURRENCE-ID;TZID=America/Toronto:20261108T193000\r\nDTSTART;TZID=America/Toronto:20261108T203000\r\nDTEND;TZID=America/Toronto:20261108T213000\r\nSUMMARY:Moved\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
function fixture() {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE events(id TEXT PRIMARY KEY,body TEXT NOT NULL);CREATE TABLE subscriptions(id TEXT PRIMARY KEY,body TEXT NOT NULL,ics TEXT);CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE delete_undo(token TEXT PRIMARY KEY,before TEXT,after TEXT,expires INTEGER)");
  db.query("INSERT INTO settings VALUES(?,?)").run("zone", "America/Toronto");
  db.query("INSERT INTO settings VALUES(?,?)").run("feedToken", "fixture-private-feed-token");
  const journal = { begin: () => null, finish: () => ({ ok: true as const }) };
  let store = new CalendarMemory(db, "alice", journal), next = 0;
  const run = async (command: unknown, id = `request-${++next}`) => {
    const parsed = parseCalendarCommand(command); if (!parsed.ok) return parsed;
    return store.execute(parsed.value, id, Date.parse("2026-10-01T00:00:00Z"));
  };
  const value = async (command: unknown, id?: string): Promise<any> => {
    const result = await run(command, id); if (!result.ok) throw new Error(JSON.stringify(result)); return result.value;
  };
  return { db, run, value, async restart() { await store.close(); store = new CalendarMemory(db, "alice", journal); }, async close() { await store.close(); db.close(); } };
}
test("explicit event fields, DST ambiguity and nonexistence, exclusive all-day end and ICS roundtrip", () => {
  const parsed = calendarEvent(event, null); expect(parsed.ok).toBe(true); if (!parsed.ok) return;
  expect(parsed.value.start).toBe("2026-10-08T23:30:00Z");
  const component = new ICAL.Component(ICAL.parse(calendarICS([parsed.value])));
  expect(component.getFirstSubcomponent("vevent")!.getFirstPropertyValue("summary")).toBe(event.title);
  expect(calendarEvent({ title: "unset" }, null).ok).toBe(false);
  expect(calendarEvent({ ...event, start: "2026-11-01T01:30", end: "2026-11-01T02:30" }, null).ok).toBe(false);
  expect(calendarEvent({ ...event, start: "2026-03-08T02:30", end: "2026-03-08T04:30" }, null).ok).toBe(false);
  expect(calendarEvent({ ...event, start: "2026-10-08T23:30:00Z", end: "2026-10-08T23:30:00.001Z" }, null).ok).toBe(true);
  expect(calendarEvent({ ...event, allDay: true, start: "2026-10-08", end: "2026-10-09" }, null).ok).toBe(true);
  expect(parseCalendarCommand({ operation: "snapshot", from: "2026-01-01", to: "2026-02-01" }).ok).toBe(false);
  expect(parseCalendarCommand({ operation: "delete", id: "id" }).ok).toBe(false);
});
test("owned wall clocks, overnight duration and all-day dates survive DST and ICS serialization", () => {
  const parsed = calendarEvent({ ...event, start: "2026-10-28T19:30", end: "2026-10-29T01:00", repeat: "weekly", repeatUntil: "2026-11-11" }, null);
  if (!parsed.ok) throw new Error(parsed.error);
  expect(ownedOccurrences(parsed.value, ...range).map(e => [e.start, e.end])).toEqual([["2026-10-29T02:30:00Z", "2026-10-29T08:00:00Z"], ["2026-11-05T03:30:00Z", "2026-11-05T09:00:00Z"], ["2026-11-12T03:30:00Z", "2026-11-12T09:00:00Z"]]);
  const allDay = calendarEvent({ ...event, allDay: true, start: "2026-10-29", end: "2026-10-30", repeat: "weekly", repeatUntil: "2026-11-05" }, null);
  if (!allDay.ok) throw new Error(allDay.error);
  expect(ownedOccurrences(allDay.value, ...range).map(e => [e.start, e.end])).toEqual([["2026-10-29", "2026-10-30"], ["2026-11-05", "2026-11-06"]]);
  for (const series of [parsed.value, allDay.value]) expect(importedEvents(calendarICS([series]), { id: "roundtrip", name: "Feed", zone: "UTC" }, ...range).map(e => [e.start.replace(".000Z", "Z"), e.end.replace(".000Z", "Z")])).toEqual(ownedOccurrences(series, ...range).map(e => [e.start, e.end]));
});
test("inbound recurrence exceptions and exclusions use IANA DST", () => {
  const imported = importedEvents(ics, { id: "s", name: "External", zone: "UTC" }, ...range);
  expect(imported.map(e => e.start)).toEqual(["2026-10-25T23:30:00Z", "2026-11-09T01:30:00Z"]);
  expect(imported[1]!.title).toBe("Moved"); expect(imported.every(e => e.readOnly)).toBe(true);
});
test("mutations survive restart idempotently, exact occurrence scope and undo CAS preserve series/settings", async () => {
  const f = fixture();
  try {
    const created: CalendarEvent = await f.value({ operation: "create", event: { ...event, repeat: "weekly" } }, "create-stable");
    await f.restart();
    expect(await f.value({ operation: "create", event: { ...event, repeat: "weekly" } }, "create-stable")).toEqual(created);
    expect((await f.run({ operation: "create", event: { ...event, title: "Other" } }, "create-stable")).ok).toBe(false);
    const agenda = (await f.value({ operation: "snapshot", from: range[0], to: range[1] })).events;
    const deleted = await f.value({ operation: "delete", id: created.id, target: { kind: "occurrence", start: agenda[1].occurrenceStart } });
    expect((await f.value({ operation: "snapshot", from: range[0], to: range[1] })).events).toHaveLength(agenda.length - 1);
    await f.value({ operation: "restore", undoToken: deleted.undoToken });
    expect((await f.value({ operation: "snapshot", from: range[0], to: range[1] })).events).toHaveLength(agenda.length);
    const conflict = await f.value({ operation: "delete", id: created.id, target: { kind: "occurrence", start: agenda[0].occurrenceStart } });
    await f.value({ operation: "update", id: created.id, target: { kind: "series" }, patch: { title: "Changed" } });
    expect(await f.run({ operation: "restore", undoToken: conflict.undoToken })).toMatchObject({ ok: false, error: { code: "conflict" } });
    const records = await f.value({ operation: "records" });
    expect(records.events).toHaveLength(1);
    expect(records.settings).toEqual([{ key: "zone", value: "America/Toronto" }, { key: "feedToken", value: "fixture-private-feed-token" }]);
    expect(await f.value({ operation: "receipt", requestId: "create-stable" })).toEqual(created);
    const a = fixture(); try { expect((await a.value({ operation: "records" })).events).toHaveLength(0); } finally { await a.close(); }
  } finally { await f.close(); }
});
test("subscription refresh is explicit, finite and retains last successful ICS on failure", async () => {
  let fail = false, fetched = 0;
  const upstream = Bun.serve({ port: 0, fetch: () => { fetched++; return fail ? new Response("failed", { status: 500 }) : new Response(ics); } });
  const f = fixture();
  try {
    await f.value({ operation: "subscribe", name: "Other", url: upstream.url.href, zone: "UTC" });
    expect(fetched).toBe(0);
    await f.value({ operation: "refresh", from: range[0], to: range[1] }, "refresh-stable");
    expect((await f.value({ operation: "snapshot", from: range[0], to: range[1] })).events).toHaveLength(2);
    await f.value({ operation: "refresh", from: range[0], to: range[1] }, "refresh-stable"); expect(fetched).toBe(1);
    fail = true; await f.value({ operation: "refresh", from: range[0], to: range[1] });
    const snapshot = await f.value({ operation: "snapshot", from: range[0], to: range[1] });
    expect(snapshot.events).toHaveLength(2); expect(snapshot.subscriptions[0].error).toContain("Refresh failed");
    expect(await f.run({ operation: "update", id: "foreign", target: { kind: "series" }, patch: { title: "No" } })).toMatchObject({ ok: false, error: { code: "not-found" } });
  } finally { upstream.stop(); await f.close(); }
});
