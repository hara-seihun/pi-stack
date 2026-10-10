import type { ContextEntry } from "../../types";

export interface BubbleGroup {
  starts: boolean;
  ends: boolean;
  day?: string;
  timestamp?: number;
}

export function messageDay(timestamp: number | undefined): string | undefined {
  if (timestamp === undefined || !Number.isFinite(timestamp) || timestamp <= 0) return undefined;
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function joins(a: ContextEntry | undefined, b: ContextEntry | undefined): boolean {
  if (!a || !b || a.kind !== b.kind) return false;
  const first = a.messageTimestamp;
  const second = b.messageTimestamp;
  return first !== undefined && second !== undefined && messageDay(first) !== undefined
    && messageDay(first) === messageDay(second) && second >= first && second - first <= 300_000;
}

export function bubbleGroups(messages: readonly ContextEntry[]): ReadonlyMap<string, BubbleGroup> {
  return new Map(messages.map((entry, index) => {
    const previous = messages[index - 1];
    const next = messages[index + 1];
    const day = messageDay(entry.messageTimestamp);
    const ends = !joins(entry, next);
    return [entry.key, {
      starts: !joins(previous, entry), ends,
      ...(day && day !== messageDay(previous?.messageTimestamp) ? { day: new Date(entry.messageTimestamp!).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" }) } : {}),
      ...(ends && day ? { timestamp: entry.messageTimestamp } : {}),
    }];
  }));
}
