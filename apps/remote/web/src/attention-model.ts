import { Temporal } from "@js-temporal/polyfill";
import type { CalendarEvent } from "../../server/calendar-protocol";
import type { HistoryNotification } from "../../server/protocol";
import type { NeedsYouItem } from "../../shared/needs-you";

export type AttentionItem =
  | { kind: "need"; id: string; at: number | null; value: NeedsYouItem }
  | { kind: "update"; id: string; at: number; value: HistoryNotification }
  | { kind: "event"; id: string; at: number; value: CalendarEvent };
export type AttentionFeed = { now: AttentionItem[]; upcoming: AttentionItem[]; history: AttentionItem[] };

export function attentionFeed(needs: readonly NeedsYouItem[], notifications: readonly HistoryNotification[], events: readonly CalendarEvent[], zone: string, now: number): AttentionFeed {
  const questionKeys = new Set(needs.flatMap(item => item.location?.questionId ? [`${item.location.threadId}:${item.location.questionId}`] : []));
  const current: AttentionItem[] = [], upcoming: AttentionItem[] = [], history: AttentionItem[] = [];
  for (const value of needs) {
    const at = value.deadline === null ? null : Date.parse(value.deadline.at);
    const item: AttentionItem = { kind: "need", id: `need:${value.id}`, at, value };
    (at === null || at <= now ? current : upcoming).push(item);
  }
  const unique = new Map(notifications.map(item => [item.seq, item]));
  for (const value of unique.values()) {
    const item: AttentionItem = { kind: "update", id: `notice:${value.seq}`, at: Date.parse(value.time), value };
    if (value.status === "history") { history.push(item); continue; }
    if (value.kind === "question" && value.questionId !== undefined && questionKeys.has(`${value.sessionId}:${value.questionId}`)) continue;
    current.push(item);
  }
  for (const value of events) {
    const at = value.allDay ? Temporal.PlainDate.from(value.start).toZonedDateTime(zone).epochMilliseconds : Date.parse(value.start);
    const end = value.allDay ? Temporal.PlainDate.from(value.end).toZonedDateTime(zone).epochMilliseconds : Date.parse(value.end);
    const item: AttentionItem = { kind: "event", id: `event:${value.id}`, at, value };
    (end <= now ? history : at <= now ? current : upcoming).push(item);
  }
  const chronological = (a: AttentionItem, b: AttentionItem) => {
    if (a.at === null) return b.at === null ? a.id.localeCompare(b.id) : -1;
    if (b.at === null) return 1;
    return a.at - b.at || a.id.localeCompare(b.id);
  };
  return {
    now: current.sort(chronological), upcoming: upcoming.sort(chronological),
    history: history.sort((a, b) => chronological(b, a)),
  };
}
