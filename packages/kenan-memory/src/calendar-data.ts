import type { Database } from "bun:sqlite";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { calendarEvent, calendarICS, importedEvents, validZone } from "./calendar-format.js";
import { ownedOccurrence, ownedOccurrences } from "./calendar-recurrence.js";
import type { CalendarEvent, CalendarSubscription } from "./calendar-contract.js";
import type { ActionJournal } from "./journal.js";
import { createHash } from "node:crypto";
const text = Type.String({ minLength: 1, maxLength: 100000 });
const closed = { additionalProperties: false };
const target = Type.Union([Type.Object({ kind: Type.Literal("series") }, closed), Type.Object({ kind: Type.Literal("occurrence"), start: text }, closed)]);
export const CalendarCommandSchema = Type.Union([
  Type.Object({ operation: Type.Literal("snapshot"), from: text, to: text }, closed),
  Type.Object({ operation: Type.Literal("records") }, closed),
  Type.Object({ operation: Type.Literal("export-ics") }, closed),
  Type.Object({ operation: Type.Literal("receipt"), requestId: text }, closed),
  Type.Object({ operation: Type.Literal("create"), event: Type.Record(Type.String(), Type.Unknown()) }, closed),
  Type.Object({ operation: Type.Literal("update"), id: text, target, patch: Type.Record(Type.String(), Type.Unknown()) }, closed),
  Type.Object({ operation: Type.Literal("delete"), id: text, target }, closed),
  Type.Object({ operation: Type.Literal("restore"), undoToken: text }, closed),
  Type.Object({ operation: Type.Literal("subscribe"), name: text, url: text, zone: text }, closed),
  Type.Object({ operation: Type.Literal("unsubscribe"), id: text }, closed),
  Type.Object({ operation: Type.Literal("refresh"), from: text, to: text }, closed),
]);
export type CalendarCommand = Static<typeof CalendarCommandSchema>;
export type CalendarResult = { ok: true; value: unknown } | { ok: false; error: { code: "invalid-command" | "not-found" | "conflict" | "unavailable" | "denied"; message: string } };
const fail = (code: Extract<CalendarResult, { ok: false }>["error"]["code"], message: string): CalendarResult => ({ ok: false, error: { code, message } });
export function parseCalendarCommand(input: unknown): { ok: true; value: CalendarCommand } | Extract<CalendarResult, { ok: false }> {
  if (!Value.Check(CalendarCommandSchema, input)) return fail("invalid-command", "Unknown calendar command, fields or target") as Extract<CalendarResult, { ok: false }>;
  if ((input.operation === "snapshot" || input.operation === "refresh") && (!/(?:Z|[+-]\d\d:\d\d)$/.test(input.from) || !/(?:Z|[+-]\d\d:\d\d)$/.test(input.to) || !Number.isFinite(Date.parse(input.from)) || !Number.isFinite(Date.parse(input.to)) || Date.parse(input.to) <= Date.parse(input.from) || Date.parse(input.to) - Date.parse(input.from) > 2 * 366 * 86400000)) return fail("invalid-command", "Use an explicit offset-bearing range of at most two years") as Extract<CalendarResult, { ok: false }>;
  return { ok: true, value: input };
}
export function calendarCommandAction(command: CalendarCommand): "read" | "write" | "delete" {
  switch (command.operation) {
    case "snapshot": case "records": case "export-ics": case "receipt": return "read";
    case "delete": case "unsubscribe": return "delete";
    case "create": case "update": case "restore": case "subscribe": case "refresh": return "write";
  }
}
export class CalendarMemory {
  private closed = false;
  private readonly controller = new AbortController();
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly db: Database, private readonly person: string, private readonly journal: Pick<ActionJournal, "begin" | "finish">) {
    const tables = new Set((db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(row => row.name));
    if (["events", "subscriptions", "settings", "delete_undo"].some(table => !tables.has(table))) throw new Error("Existing calendar custody schema is missing");
    db.exec("CREATE TABLE IF NOT EXISTS calendar_receipts(id TEXT PRIMARY KEY,payload TEXT NOT NULL,result TEXT NOT NULL)");
  }
  async close() { this.closed = true; this.controller.abort(); await this.queue; }
  execute(command: CalendarCommand, requestId: string, now: number): Promise<CalendarResult> {
    if (this.closed) return Promise.resolve(fail("unavailable", "Calendar memory is closed"));
    const pending = this.queue.then(async (): Promise<CalendarResult> => {
      try {
        const payload = JSON.stringify(command), prior = this.db.query("SELECT payload,result FROM calendar_receipts WHERE id=?").get(requestId) as { payload: string; result: string } | null;
        if (prior) return prior.payload === payload ? JSON.parse(prior.result) : fail("conflict", "Data request ID already has another command");
        if (command.operation === "refresh") return await this.refresh(command, requestId, now);
        return this.dispatch(command, requestId, now);
      } catch { return fail("unavailable", "Calendar data operation could not finish; inspect its request receipt before repeating a mutation"); }
    });
    this.queue = pending.then(() => undefined);
    return pending;
  }
  private events(): CalendarEvent[] { return (this.db.query("SELECT body FROM events").all() as { body: string }[]).map(row => JSON.parse(row.body)); }
  private subscriptions(): CalendarSubscription[] { return (this.db.query("SELECT body FROM subscriptions").all() as { body: string }[]).map(row => JSON.parse(row.body)); }
  private save(event: CalendarEvent) { this.db.query("INSERT OR REPLACE INTO events VALUES(?,?)").run(event.id, JSON.stringify(event)); }
  private commit(command: CalendarCommand, requestId: string, summary: string, write: () => unknown): CalendarResult {
    const ticket = this.journal.begin({ action: `calendar.${command.operation}`, actedFor: this.person, recipients: [this.person], summary, externalId: requestId, obviouslyPrivate: true });
    let result: CalendarResult;
    try {
      result = this.db.transaction(() => {
        const value = write(), result: CalendarResult = { ok: true, value };
        this.db.query("INSERT INTO calendar_receipts VALUES(?,?,?)").run(requestId, JSON.stringify(command), JSON.stringify(result));
        return result;
      })();
    } catch {
      this.journal.finish(ticket, "failed", "Calendar transaction rolled back");
      return fail("unavailable", "Calendar transaction failed before commit");
    }
    try {
      const finished = this.journal.finish(ticket, "confirmed", `Memory data receipt ${requestId}`);
      if (finished.ok) return result;
    } catch { /* The committed receipt fences the mutation while its outbox is repaired. */ }
    const pending: CalendarResult = { ok: true, value: { data: result.value, journal: "pending", requestId } };
    this.db.query("UPDATE calendar_receipts SET result=? WHERE id=?").run(JSON.stringify(pending), requestId);
    return pending;
  }
  private deletion(before: CalendarEvent, after: CalendarEvent | null, now: number): string {
    const token = crypto.randomUUID();
    this.db.query("INSERT INTO delete_undo VALUES(?,?,?,?)").run(token, JSON.stringify(before), after === null ? null : JSON.stringify(after), now + 600000);
    if (after === null) this.db.query("DELETE FROM events WHERE id=?").run(before.id); else this.save(after);
    return token;
  }
  private dispatch(command: Exclude<CalendarCommand, { operation: "refresh" }>, requestId: string, now: number): CalendarResult {
    switch (command.operation) {
      case "records": return { ok: true, value: { events: this.events(), subscriptions: this.subscriptions(), subscriptionSources: this.db.query("SELECT id,body,ics FROM subscriptions").all(), settings: this.db.query("SELECT * FROM settings").all(), undo: this.db.query("SELECT * FROM delete_undo").all() } };
      case "receipt": { const row = this.db.query("SELECT result FROM calendar_receipts WHERE id=?").get(command.requestId) as { result: string } | null; return row ? JSON.parse(row.result) : fail("not-found", "Data request has no committed mutation receipt"); }
      case "export-ics": return { ok: true, value: { ics: calendarICS(this.events()) } };
      case "snapshot": {
        const subscriptions = this.subscriptions(), failures: { subscriptionId: string; error: string }[] = [];
        const events = this.events().flatMap(event => ownedOccurrences(event, command.from, command.to));
        for (const subscription of subscriptions) {
          const row = this.db.query("SELECT ics FROM subscriptions WHERE id=?").get(subscription.id) as { ics: string | null };
          if (row.ics === null || row.ics === "") continue;
          try { events.push(...importedEvents(row.ics, subscription, command.from, command.to)); } catch { failures.push({ subscriptionId: subscription.id, error: "Saved ICS cannot be expanded in this range" }); }
        }
        return { ok: true, value: { events: events.sort((a, b) => a.start.localeCompare(b.start)), subscriptions, failures } };
      }
      case "create": {
        const parsed = calendarEvent(command.event, null); if (!parsed.ok) return fail("invalid-command", parsed.error);
        return this.commit(command, requestId, parsed.value.title, () => { this.save(parsed.value); return parsed.value; });
      }
      case "update": case "delete": {
        const previous = this.events().find(event => event.id === command.id); if (!previous) return fail("not-found", "Owned event not found; imported events are read-only");
        if (command.target.kind === "series") {
          if (command.operation === "delete") return this.commit(command, requestId, previous.title, () => ({ undoToken: this.deletion(previous, null, now) }));
          const parsed = calendarEvent(command.patch, previous); if (!parsed.ok) return fail("invalid-command", parsed.error);
          return this.commit(command, requestId, previous.title, () => { this.save(parsed.value); return parsed.value; });
        }
        const original = command.target.start, occurrence = ownedOccurrence(previous, original);
        if (!occurrence) return fail("not-found", "Recurring occurrence not found");
        const existing = previous.exceptions?.[original];
        if (existing === null && command.operation === "delete") return fail("not-found", "Occurrence already deleted");
        if (command.operation === "delete") {
          const after = { ...previous, updated: new Date(now).toISOString(), exceptions: { ...previous.exceptions, [original]: null } };
          return this.commit(command, requestId, occurrence.title, () => ({ undoToken: this.deletion(previous, after, now) }));
        }
        const parsed = calendarEvent({ ...command.patch, repeat: null, repeatUntil: null }, existing === undefined || existing === null ? occurrence : existing);
        if (!parsed.ok) return fail("invalid-command", parsed.error);
        if (parsed.value.allDay !== previous.allDay) return fail("invalid-command", "Change all-day type on the series, not one occurrence");
        const after = { ...previous, updated: new Date(now).toISOString(), exceptions: { ...previous.exceptions, [original]: parsed.value } };
        return this.commit(command, requestId, occurrence.title, () => { this.save(after); return { ...parsed.value, seriesId: previous.id, occurrenceStart: original }; });
      }
      case "restore": {
        const undo = this.db.query("SELECT before,after,expires FROM delete_undo WHERE token=?").get(command.undoToken) as { before: string; after: string | null; expires: number } | null;
        if (!undo || undo.expires <= now) return fail("not-found", "Undo is absent or expired");
        const before: CalendarEvent = JSON.parse(undo.before), row = this.db.query("SELECT body FROM events WHERE id=?").get(before.id) as { body: string } | null;
        if ((row === null ? null : row.body) !== undo.after) return fail("conflict", "The event changed after deletion; restore would overwrite it");
        return this.commit(command, requestId, before.title, () => { this.save(before); this.db.query("DELETE FROM delete_undo WHERE token=?").run(command.undoToken); return before; });
      }
      case "subscribe": {
        if (command.name.length > 200 || !command.name.trim() || command.url.length > 8000 || !validZone(command.zone)) return fail("invalid-command", "Subscription name, HTTP(S) URL and explicit timezone are required");
        let url: URL; try { url = new URL(command.url.replace(/^webcal:/, "https:")); } catch { return fail("invalid-command", "Invalid subscription URL"); }
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return fail("invalid-command", "Use HTTP(S) without embedded credentials");
        const subscription: CalendarSubscription = { id: crypto.randomUUID(), name: command.name.trim(), url: url.href, zone: command.zone, refreshed: null, error: null };
        return this.commit(command, requestId, subscription.name, () => { this.db.query("INSERT INTO subscriptions VALUES(?,?,?)").run(subscription.id, JSON.stringify(subscription), ""); return subscription; });
      }
      case "unsubscribe": {
        const prior = this.subscriptions().find(subscription => subscription.id === command.id); if (!prior) return fail("not-found", "Subscription not found");
        return this.commit(command, requestId, prior.name, () => { this.db.query("DELETE FROM subscriptions WHERE id=?").run(command.id); return { removed: command.id }; });
      }
    }
  }
  private async refresh(command: Extract<CalendarCommand, { operation: "refresh" }>, requestId: string, now: number): Promise<CalendarResult> {
    const { from, to } = command;
    const failures: string[] = [], updates: { subscription: CalendarSubscription; ics: string | null }[] = [];
    await Promise.all(this.subscriptions().map(async subscription => {
      try {
        const response = await fetch(subscription.url, { signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(20000)]), headers: { accept: "text/calendar" } });
        if (!response.ok || !response.body) throw new Error("Source fetch failed");
        const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
        try { for (;;) { const item = await reader.read(); if (item.done) break; size += item.value.length; if (size > 4 * 1024 * 1024) throw new Error("Source too large"); chunks.push(item.value); } } finally { await reader.cancel(); }
        const body = Buffer.concat(chunks).toString("utf8"); importedEvents(body, subscription, from, to);
        updates.push({ subscription: { ...subscription, refreshed: new Date(now).toISOString(), error: null }, ics: body });
      } catch {
        failures.push(subscription.id);
        if (!this.controller.signal.aborted) updates.push({ subscription: { ...subscription, error: "Refresh failed; retained the last successful ICS copy" }, ics: null });
      }
    }));
    if (this.controller.signal.aborted) return fail("unavailable", "Refresh cancelled before cache commit");
    return this.commit(command, requestId, "Refresh previously saved calendar subscriptions", () => {
      for (const { subscription, ics } of updates) {
        if (ics === null) this.db.query("UPDATE subscriptions SET body=? WHERE id=?").run(JSON.stringify(subscription), subscription.id);
        else this.db.query("UPDATE subscriptions SET body=?,ics=? WHERE id=?").run(JSON.stringify(subscription), ics, subscription.id);
      }
      return { subscriptions: this.subscriptions(), failures, sourceDigest: createHash("sha256").update(JSON.stringify(this.subscriptions())).digest("hex") };
    });
  }
}
