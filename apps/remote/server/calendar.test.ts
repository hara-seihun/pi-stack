import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ICAL from "ical.js";
import { CalendarStore, calendarEvent, calendarICS, importedEvents } from "./calendar";
import { calendarInvocation } from "./calendar-cli";
import { ownedOccurrences } from "./calendar-recurrence";
const range = ["2026-10-01T00:00:00Z", "2026-12-01T00:00:00Z"] as const;
const event = { title: "Appointment, with punctuation; and\na second line", start: "2026-10-08T16:30", end: "2026-10-08T17:30", zone: "America/Los_Angeles", notes: "private", location: "Online" };
test("zones, DST rejection, all-day exclusive end, fractional instants and ICS round trip", () => {
  const parsed = calendarEvent(event); expect(parsed.ok).toBe(true); if (!parsed.ok) return;
  expect(parsed.value.start).toBe("2026-10-08T23:30:00Z");
  const component = new ICAL.Component(ICAL.parse(calendarICS([parsed.value])));
  expect(component.getFirstSubcomponent("vevent")!.getFirstPropertyValue("summary")).toBe(event.title);
  expect(calendarEvent({ ...event, start: "2026-11-01T01:30", end: "2026-11-01T02:30" }).ok).toBe(false);
  expect(calendarEvent({ ...event, start: "2026-03-08T02:30", end: "2026-03-08T04:30" }).ok).toBe(false);
  expect(calendarEvent({ ...event, start: "2026-10-08T23:30:00Z", end: "2026-10-08T23:30:00.001Z" }).ok).toBe(true);
  expect(calendarEvent({ ...event, allDay: true, start: "2026-10-08", end: "2026-10-09" }).ok).toBe(true);
});
const ics = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:weekly\r\nSUMMARY:Weekly\r\nDTSTART;TZID=America/Toronto:20261025T193000\r\nDTEND;TZID=America/Toronto:20261025T203000\r\nRRULE:FREQ=WEEKLY;COUNT=3\r\nEXDATE;TZID=America/Toronto:20261101T193000\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:weekly\r\nRECURRENCE-ID;TZID=America/Toronto:20261108T193000\r\nDTSTART;TZID=America/Toronto:20261108T203000\r\nDTEND;TZID=America/Toronto:20261108T213000\r\nSUMMARY:Moved\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
test("inbound recurrence, exception, exclusion and IANA DST without embedded VTIMEZONE", () => {
  const imported = importedEvents(ics, { id: "s", name: "External", zone: "UTC" }, ...range);
  expect(imported.map(e => e.start)).toEqual(["2026-10-25T23:30:00Z", "2026-11-09T01:30:00Z"]);
  expect(imported[1]!.title).toBe("Moved"); expect(imported.every(e => e.readOnly)).toBe(true);
});
test("two people have independent state; token rotation revokes; CRUD persists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-calendar-")); const a = new CalendarStore(join(dir, "a"), "alice"), b = new CalendarStore(join(dir, "b"), "bob");
  const call = (store: CalendarStore, path: string, method = "GET", body?: unknown) => store.handle(new Request("http://localhost/v1/calendar" + path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  try {
    const created = await (await call(a, "/events", "POST", event)).json(); expect(a.ownEvents()).toHaveLength(1); expect(b.ownEvents()).toHaveLength(0);
    const feed = await (await call(a, "/feed")).json(); const token = feed.url.split("/").at(-1).replace(".ics", "");
    expect((await call(a, "/feed/" + token)).status).toBe(200); expect((await call(b, "/feed/" + token)).status).toBe(404);
    await call(a, "/feed", "POST", {}); expect((await call(a, "/feed/" + token)).status).toBe(404);
    await call(a, "/events/" + created.id, "PATCH", { title: "Changed" }); expect(a.ownEvents()[0]!.title).toBe("Changed");
    expect((await call(a, "/events/" + created.id, "DELETE")).status).toBe(200); expect(a.ownEvents()).toHaveLength(0);
  } finally { await a.close(); await b.close(); rmSync(dir, { recursive: true, force: true }); }
});
test("inbound subscriptions fetch and survive failure with visible stale state", async () => {
  let fail = false; const upstream = Bun.serve({ port: 0, fetch: () => fail ? new Response("failed", { status: 500 }) : new Response(ics) });
  const dir = mkdtempSync(join(tmpdir(), "pi-calendar-")); const store = new CalendarStore(dir, "alice");
  try {
    const response = await store.handle(new Request("http://localhost/v1/calendar/subscriptions", { method: "POST", body: JSON.stringify({ name: "Other", url: upstream.url.href, zone: "UTC" }) }));
    expect(response.status).toBe(200); expect(store.snapshot(...range).events).toHaveLength(2);
    fail = true; await store.refresh(); expect(store.subscriptions()[0]!.error).toContain("Refresh failed"); expect(store.snapshot(...range).events).toHaveLength(2);
    expect((await store.handle(new Request("http://localhost/v1/calendar/events/foreign", { method: "PATCH", body: "{}" }))).status).toBe(404);
  } finally { upstream.stop(); await store.close(); rmSync(dir, { recursive: true, force: true }); }
});
test("owned weekly wall clocks, overnight ends, all-day dates and inclusive until survive DST", () => {
  const parsed = calendarEvent({ ...event, start: "2026-10-28T19:30", end: "2026-10-29T01:00", repeat: "weekly", repeatUntil: "2026-11-11" });
  expect(parsed.ok).toBe(true); if (!parsed.ok) return;
  const expanded = ownedOccurrences(parsed.value, ...range);
  expect(expanded.map(e => [e.start, e.end])).toEqual([
    ["2026-10-29T02:30:00Z", "2026-10-29T08:00:00Z"],
    ["2026-11-05T03:30:00Z", "2026-11-05T09:00:00Z"],
    ["2026-11-12T03:30:00Z", "2026-11-12T09:00:00Z"],
  ]);
  const spring = calendarEvent({ ...event, start: "2026-03-04T19:30", end: "2026-03-05T01:00", repeat: "weekly" });
  if (!spring.ok) throw new Error(spring.error);
  expect(ownedOccurrences(spring.value, "2026-03-01T00:00:00Z", "2026-03-13T00:00:00Z").map(e => e.start)).toEqual(["2026-03-05T03:30:00Z", "2026-03-12T02:30:00Z"]);
  const allDay = calendarEvent({ ...event, allDay: true, start: "2026-10-29", end: "2026-10-30", repeat: "weekly", repeatUntil: "2026-11-05" });
  if (!allDay.ok) throw new Error(allDay.error);
  expect(ownedOccurrences(allDay.value, ...range).map(e => [e.start, e.end])).toEqual([["2026-10-29", "2026-10-30"], ["2026-11-05", "2026-11-06"]]);
  for (const series of [parsed.value, allDay.value]) {
    const feed = calendarICS([series]);
    expect(feed).toContain("RRULE:FREQ=WEEKLY;UNTIL=");
    const imported = importedEvents(feed, { id: "roundtrip", name: "Feed", zone: "UTC" }, ...range);
    expect(imported.map(e => [e.start.replace(".000Z", "Z"), e.end.replace(".000Z", "Z")])).toEqual(ownedOccurrences(series, ...range).map(e => [e.start, e.end]));
  }
});
test("occurrence edit/delete and feed EXDATE never mutate the entire series implicitly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-repeat-")); let store = new CalendarStore(dir, "alice");
  const call = (path: string, method = "GET", body?: unknown) => store.handle(new Request("http://localhost/v1/calendar" + path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  try {
    const series = await (await call("/events", "POST", { ...event, repeat: "weekly" })).json();
    const agenda = store.snapshot(...range).events; expect(agenda.length).toBeGreaterThan(4);
    expect((await call(`/events/${series.id}`, "DELETE")).status).toBe(400);
    expect((await call(`/events/${series.id}`, "PATCH", { title: "Oops" })).status).toBe(400);
    expect((await call(`/events/${encodeURIComponent(agenda[1]!.id)}`, "DELETE")).status).toBe(200);
    expect(store.snapshot(...range).events).toHaveLength(agenda.length - 1);
    const moved = { title: "Just this one", start: "2027-01-01T10:00", end: "2027-01-01T11:00" };
    expect((await call(`/events/${encodeURIComponent(agenda[2]!.id)}`, "PATCH", moved)).status).toBe(200);
    expect(store.ownEvents()[0]!.title).toBe(event.title);
    expect(store.snapshot("2027-01-01T00:00:00Z", "2027-01-02T00:00:00Z").events.some(e => e.title === moved.title)).toBe(true);
    const feed = calendarICS(store.ownEvents()); expect(feed).toContain("EXDATE;TZID=America/Los_Angeles:"); expect(feed).toContain("RECURRENCE-ID;TZID=America/Los_Angeles:");
    expect(importedEvents(feed, { id: "feed", name: "Feed", zone: "UTC" }, ...range).map(e => e.start.replace(".000Z", "Z"))).toEqual(store.snapshot(...range).events.map(e => e.start));
    await store.close(); store = new CalendarStore(dir, "alice"); expect(store.snapshot(...range).events).toHaveLength(agenda.length - 2);
    const deleted = await (await call(`/events/${series.id}?scope=series`, "DELETE")).json(); expect(store.ownEvents()).toHaveLength(0);
    expect((await call(`/undo/${deleted.undoToken}`, "POST", {})).status).toBe(200); expect(store.snapshot(...range).events).toHaveLength(agenda.length - 2);
    const single = await (await call(`/events/${encodeURIComponent(agenda[0]!.id)}`, "DELETE")).json();
    expect((await call(`/undo/${single.undoToken}`, "POST", {})).status).toBe(200);
    const conflict = await (await call(`/events/${encodeURIComponent(agenda[0]!.id)}`, "DELETE")).json();
    await call(`/events/${series.id}?scope=series`, "PATCH", { title: "New series title" });
    expect((await call(`/undo/${conflict.undoToken}`, "POST", {})).status).toBe(409);
  } finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
});
test("CLI commands map to one person's API", () => {
  expect(calendarInvocation(["update", "id", "--repeat", "weekly", "--repeat-until", "2026-12-31"])).toMatchObject({ ok: true, body: { repeat: "weekly", repeatUntil: "2026-12-31" } });
  expect(calendarInvocation(["delete", "id", "--scope", "occurrence", "--occurrence", "2026-11-05T03:30:00Z"])).toMatchObject({ ok: true, path: "/v1/calendar/events/id?scope=occurrence&occurrence=2026-11-05T03%3A30%3A00Z" });
  expect(calendarInvocation(["add", "--title", "Test", "--start", "2026-10-08", "--end", "2026-10-09", "--all-day"])).toMatchObject({ ok: true, method: "POST", path: "/v1/calendar/events", body: { allDay: true } });
  expect(calendarInvocation(["feed"])).toEqual({ ok: true, method: "GET", path: "/v1/calendar/feed" });
  expect(calendarInvocation(["unsubscribe", "id"])).toMatchObject({ ok: true, method: "DELETE", path: "/v1/calendar/subscriptions/id" });
});
