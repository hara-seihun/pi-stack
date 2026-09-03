import type { ContextEntry } from "./types";

export type TranscriptItem =
  | { kind: "message"; key: string; entry: ContextEntry }
  | { kind: "details"; key: string; entries: ContextEntry[] };

function staysVisible(entry: ContextEntry) {
  return entry.kind === "user" || entry.kind === "assistant";
}

export function groupTranscriptEntries(entries: ContextEntry[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];

  for (const entry of entries) {
    if (staysVisible(entry)) {
      items.push({ kind: "message", key: entry.key, entry });
      continue;
    }

    const previous = items.at(-1);
    if (previous?.kind === "details") {
      previous.entries.push(entry);
    } else {
      items.push({ kind: "details", key: `details-after:${previous?.key ?? "start"}`, entries: [entry] });
    }
  }

  return items;
}
