import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionJournal } from "kenan-memory/journal";
import type { MemoryInput, MemoryClient } from "kenan-memory/contract";
import { PhoneBroker } from "./phones";
import { CalendarStore } from "./calendar";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kenan-boundary-")), items: MemoryInput[] = [];
  const client = { async request(request: any) { items.push(request.item); return { ok: true, value: request.item }; } } as MemoryClient;
  return { root, items, journal: new ActionJournal({ directory: join(root, "journal"), enabled: () => true, person: "alice", autoDrain: false, client }) };
}
test("Android SMS/dial/calendar capture accepted requests, not carrier delivery; reads do not journal", async () => {
  const f = fixture(), broker = new PhoneBroker({ journal: f.journal });
  const frames: any[] = [];
  const connection = broker.open({ send(frame) { frames.push(JSON.parse(frame)); }, close() {} });
  broker.receive(connection, JSON.stringify({ type: "hello", device: { id: "test-phone", name: "Fixture", model: "test", android: "36", capabilities: {} } }));
  try {
    for (const [command, args] of [["sms.send", { to: "+15555550100", text: "Foundation schedule", confirm: true }], ["call.dial", { number: "+15555550100", confirm: true }], ["calendar.insert", { calendarId: 1, title: "Foundation meeting", start: 1, end: 2 }], ["sms.list", {}]] as const) {
      const task = broker.execute("test-phone", { command, args });
      const sent = frames.at(-1);
      broker.receive(connection, JSON.stringify({ type: "result", id: sent.id, ok: true, result: { status: "submitted" } }));
      expect((await task).ok).toBe(true);
    }
    await f.journal.drain();
    expect(f.items.filter(item => item.source.action?.endsWith(":confirmed"))).toHaveLength(3);
    expect(f.items.some(item => item.text.includes("not proof of carrier delivery"))).toBe(true);
    expect(f.items.some(item => item.source.action?.includes("sms.list"))).toBe(false);
  } finally { broker.stop(); rmSync(f.root, { recursive: true, force: true }); }
});
test("calendar creates, changes, deletes and restores journal committed mutations", async () => {
  const f = fixture(), calendar = new CalendarStore(f.root, "alice", "", f.journal);
  const request = (path: string, method: string, body?: unknown) => new Request(`http://fixture/v1/calendar${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    const event = await (await calendar.handle(request("/events", "POST", { title: "Foundation meeting", start: "2026-10-04T12:00:00Z", end: "2026-10-04T13:00:00Z" }))).json();
    await calendar.handle(request(`/events/${event.id}`, "PATCH", { title: "Foundation inspection" }));
    const removed = await (await calendar.handle(request(`/events/${event.id}`, "DELETE"))).json();
    await calendar.handle(request(`/undo/${removed.undoToken}`, "POST", {}));
    await f.journal.drain();
    expect(f.items.filter(item => item.source.action?.endsWith(":confirmed")).map(item => item.source.action).sort()).toEqual(["calendar.create:confirmed", "calendar.delete:confirmed", "calendar.restore:confirmed", "calendar.update:confirmed"]);
    expect(calendar.ownEvents()[0]!.title).toBe("Foundation inspection");
  } finally { await calendar.close(); rmSync(f.root, { recursive: true, force: true }); }
});
