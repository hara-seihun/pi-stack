import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { estimateTokens, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { patchCompactionCut } from "./patch-compaction-cut.mjs";

const base = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const chunks = join(base, "bundle/chunks");
const paths = [join(base, "core/compaction/compaction.js"), ...readdirSync(chunks).filter(name => name.endsWith(".js")).map(name => join(chunks, name)).filter(path => /function findCutPoint\d*\(/u.test(readFileSync(path, "utf8")))];
for (const path of paths) test(`Pi keeps a trailing tool batch together in ${path.includes("chunks") ? "bundled CLI" : "SDK"}`, () => {
  const source = patchCompactionCut(readFileSync(path, "utf8"));
  assert.equal(patchCompactionCut(source), source);
  for (const match of source.matchAll(/function (findCutPoint\d*)\(/gu)) {
    const section = source.slice(match.index, source.indexOf("SUMMARIZATION_", match.index)).replace(/\b(?:const|var)\s*$/u, "");
    const names = ["findValidCutPoints", "findValidCutPoints2", "sessionEntryToContextMessages", "estimateTokens", "estimateTokens2", "estimateTokens3", "isTurnStartEntry", "findTurnStartIndex", "findTurnStartIndex2"];
    const valid = entries => entries.flatMap((entry, index) => ["user", "assistant"].includes(entry.message.role) ? [index] : []);
    const cut = new Function(...names, `${section}; return ${match[1]};`)(valid, valid, sessionEntryToContextMessages, estimateTokens, estimateTokens, estimateTokens, entry => entry.message.role === "user", () => 0, () => 0);
    const entries = [
      { role: "user", content: "u".repeat(2000), timestamp: 1 },
      { role: "assistant", content: [{ type: "toolCall", id: "call", name: "probe", arguments: {} }], timestamp: 2 },
      { role: "toolResult", toolCallId: "call", content: [{ type: "text", text: "r".repeat(400) }], timestamp: 3 },
    ].map((message, index) => ({ type: "message", id: String(index), message }));
    assert.equal(cut(entries, 0, entries.length, 1).firstKeptEntryIndex, 1);
    assert.equal(cut(entries, 0, entries.length, 100).firstKeptEntryIndex, 1);
    assert.equal(cut(entries, 0, entries.length, 10000).firstKeptEntryIndex, 0);
  }
});
