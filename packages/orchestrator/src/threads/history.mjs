import { existsSync, readFileSync } from "node:fs";

export function readThreadHistory(path, leafId) {
  if (!existsSync(path)) return [];
  return activePath(parseSession(readFileSync(path, "utf8")), leafId);
}

export function visibleThreadHistory(path, leafId) {
  return readThreadHistory(path, leafId).flatMap(entry => {
    if (!["message", "custom_message"].includes(entry.type)) return [];
    if (entry.message?.role !== "assistant" || !Array.isArray(entry.message.content)) return [entry];
    const content = entry.message.content.filter(block => block.type !== "thinking").map(block => {
      const { thinkingSignature, textSignature, encrypted_content, encryptedContent, thoughtSignature, ...visible } = block;
      return visible;
    });
    return [{ ...entry, message: { ...entry.message, content } }];
  });
}

export function parseSession(text) {
  const entries = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch (error) {
      if (index === lines.length - 1) break;
      throw new Error(`Invalid session JSONL at line ${index + 1}: ${error.message}`);
    }
  }
  return entries;
}

/** The newest stored entry is the persisted branch tip; a live runtime can supply an explicit leaf. */
export function activePath(entries, leafId) {
  const tree = entries.filter((entry) => entry.type !== "session" && entry.id);
  const byId = new Map(tree.map((entry) => [entry.id, entry]));
  let leaf = leafId === undefined ? tree.at(-1) : byId.get(leafId);
  if (leafId !== undefined && !leaf) throw new Error(`Session entry not found: ${leafId}`);
  const path = [];
  const visited = new Set();
  for (let cursor = leaf; cursor; cursor = byId.get(cursor.parentId)) {
    if (visited.has(cursor.id)) throw new Error(`Cycle in session parent chain at ${cursor.id}`);
    visited.add(cursor.id);
    path.push(cursor);
    if (cursor.parentId && !byId.has(cursor.parentId)) throw new Error(`Missing session parent ${cursor.parentId} for ${cursor.id}`);
  }
  return path.reverse();
}

export function timestampMs(value) {
  const parsed = typeof value === "number" ? value : Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function sessionRecords(text) {
  const entries = parseSession(text);
  let index = 0;
  return text.split("\n").flatMap((raw, line) => {
    if (!raw.trim() || index >= entries.length) return [];
    return [{ entry: entries[index++], raw, line: line + 1 }];
  });
}
