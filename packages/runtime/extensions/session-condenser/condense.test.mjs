import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activePath,
  buildSegments,
  flattenPath,
  hashBlock,
  lookupSummaries,
  markVerbatim,
  openSummaryDb,
  parseSession,
  pass1Jobs,
  renderCondensed,
  rowJobs,
  storeSummary,
} from "./condense.mjs";

const entry = (id, parentId, message) => ({ type: "message", id, parentId, timestamp: "2026-08-25T10:00:00.000Z", message });
const big = (seed) => seed.repeat(2000); // 10k chars for 5-char seeds
const header = { type: "session", version: 3, id: "s1", timestamp: "2026-08-25T10:00:00.000Z", cwd: "/home/kenan" };

/** `calls` toolCall/toolResult exchanges with short thinking between. */
function grind(lines, fromId, calls, tag) {
  let parent = fromId;
  for (let i = 0; i < calls; i++) {
    const callId = `${tag}c${i}`;
    lines.push(entry(callId, parent, {
      role: "assistant",
      model: "claude-opus-5",
      content: [
        { type: "thinking", thinking: `checking ${tag}${i}` },
        { type: "toolCall", id: `t-${tag}${i}`, name: "bash", arguments: { command: `grep pattern-${tag}${i}` } },
      ],
      timestamp: 1787630000000 + i,
    }));
    const resultId = `${tag}r${i}`;
    lines.push(entry(resultId, callId, {
      role: "toolResult", toolCallId: `t-${tag}${i}`, toolName: "bash",
      content: [{ type: "text", text: `match in file-${tag}${i}.txt ` + "pad ".repeat(60) }], isError: false, timestamp: 1787630000001 + i,
    }));
    parent = resultId;
  }
  return parent;
}

/** user → reply → big thinking → grind → reply → user → grind(tail) */
function fixture({ grindCalls = 20, tailCalls = 12 } = {}) {
  const lines = [header];
  lines.push(entry("u1", null, { role: "user", content: [{ type: "text", text: "prove the lemma" }], timestamp: 1787629999000 }));
  lines.push(entry("a1", "u1", {
    role: "assistant", model: "claude-opus-5",
    content: [{ type: "thinking", thinking: big("deep!") }, { type: "text", text: "Starting the census now." }],
    timestamp: 1787629999500,
  }));
  let parent = grind(lines, "a1", grindCalls, "g");
  lines.push(entry("a2", parent, {
    role: "assistant", model: "claude-opus-5",
    content: [{ type: "text", text: "Census done: 42 groups verified, 3 remain." }],
    timestamp: 1787630001000,
  }));
  lines.push(entry("u2", "a2", { role: "user", content: [{ type: "text", text: "nice, continue" }], timestamp: 1787630002000 }));
  parent = grind(lines, "u2", tailCalls, "z");
  lines.push(entry("end", parent, { role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: "Done." }], timestamp: 1787630003000 }));
  return lines.map((line) => JSON.stringify(line)).join("\n");
}

const itemsOf = (text) => markVerbatim(flattenPath(activePath(parseSession(text))));

test("active path skips abandoned branches", () => {
  const lines = fixture().split("\n").map((l) => JSON.parse(l));
  lines.splice(3, 0, { type: "message", id: "dead", parentId: "u1", timestamp: "x", message: { role: "assistant", content: [{ type: "text", text: "ABANDONED" }] } });
  const path = activePath(lines.filter((l) => l.id));
  assert.equal(path.some((e) => e.id === "dead"), false);
  assert.equal(path.at(-1).id, "end");
});

test("verbatim anchors: user messages, the reply before each user message, the tail", () => {
  const items = itemsOf(fixture());
  for (const item of items.filter((i) => i.kind === "user")) assert.ok(item.verbatim);
  // "Census done" precedes u2 → verbatim; "Starting the census" does not precede a user message
  assert.ok(items.find((i) => i.text.startsWith("Census done")).verbatim);
  assert.ok(!items.find((i) => i.text.startsWith("Starting the census")).verbatim);
  // 12 tail calls > 10: tail starts inside the z grind, all z items from the 10th-last call on are verbatim
  const tailCalls = items.filter((i) => i.kind === "toolCall" && i.verbatim);
  assert.equal(tailCalls.length, 10);
  const gCalls = items.filter((i) => i.kind === "toolCall" && i.text.includes("pattern-g"));
  assert.ok(gCalls.every((i) => !i.verbatim));
});

test("pass 1 takes exactly the big non-verbatim blocks", () => {
  const items = itemsOf(fixture());
  const jobs = pass1Jobs(items, 4000);
  assert.deepEqual(jobs.map((j) => j.kind), ["thinking"]);
  assert.equal(jobs[0].hash, hashBlock(big("deep!")));
  assert.equal(pass1Jobs(items, 4000).length, 1); // idempotent, deduplicated
});

test("pass 2 rows form between anchors, carry condensed context, and small rows stay verbatim", () => {
  const items = itemsOf(fixture());
  pass1Jobs(items, 4000);
  const summaries = new Map([[hashBlock(big("deep!")), { summary: "DEEP-SUMMARY" }]]);
  const segments = buildSegments(items, 4000, summaries);
  const rows = segments.filter((s) => s.type === "row");
  assert.equal(rows.length, 1); // the g grind (+ "Starting the census" prose folds in)
  const input = rows[0].chunks[0].text;
  assert.match(input, /=== context — what came just before \(do not summarize\) ===\n\(summary of a thinking block\) DEEP-SUMMARY/);
  assert.match(input, /=== context — what comes just after \(do not summarize\) ===\nCensus done: 42 groups verified/);
  assert.match(input, /→ bash\({"command":"grep pattern-g0"}\)/);
  assert.match(input, /\[assistant text]\nStarting the census now\./);
  assert.equal(rowJobs(segments).length, 1);
  // a tiny stretch (single short thinking between two user messages) stays as items
  const tiny = [header,
    entry("u1", null, { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 }),
    entry("a1", "u1", { role: "assistant", content: [{ type: "thinking", thinking: "hm" }, { type: "text", text: "hello" }], timestamp: 2 }),
    entry("u2", "a1", { role: "user", content: [{ type: "text", text: "bye" }], timestamp: 3 }),
  ].map((l) => JSON.stringify(l)).join("\n");
  const tinySegments = buildSegments(itemsOf(tiny), 4000, new Map());
  assert.equal(tinySegments.filter((s) => s.type === "row").length, 0);
  assert.equal(rowJobs(tinySegments).length, 0);
});

test("memoization stability: growing the session does not change settled row hashes", () => {
  const base = fixture({ grindCalls: 20, tailCalls: 12 });
  const baseItems = itemsOf(base);
  pass1Jobs(baseItems, 4000);
  const summaries = new Map([[hashBlock(big("deep!")), { summary: "DEEP-SUMMARY" }]]);
  const baseRow = buildSegments(baseItems, 4000, summaries).find((s) => s.type === "row");

  // session grows: more tail grind and a new user exchange appended
  const grown = fixture({ grindCalls: 20, tailCalls: 40 });
  const grownItems = itemsOf(grown);
  pass1Jobs(grownItems, 4000);
  const grownRows = buildSegments(grownItems, 4000, summaries).filter((s) => s.type === "row");
  assert.equal(grownRows[0].chunks[0].hash, baseRow.chunks[0].hash);
});

test("render: anchors verbatim, summaries substituted, failures loud", () => {
  const items = itemsOf(fixture());
  pass1Jobs(items, 4000);
  const summaries = new Map([[hashBlock(big("deep!")), { summary: "DEEP-SUMMARY" }]]);
  const segments = buildSegments(items, 4000, summaries);
  const rowChunk = segments.find((s) => s.type === "row").chunks[0];
  summaries.set(rowChunk.hash, { summary: "ROW-SUMMARY" });
  const text = renderCondensed(segments, 4000, summaries, "fixture.jsonl", header);
  assert.match(text, /user:\nprove the lemma/);
  assert.match(text, /Census done: 42 groups verified/);
  assert.match(text, /\[10,000 chars · summarized]\nDEEP-SUMMARY/);
  assert.match(text, /condensed row · \d+ blocks \(20 tool calls\) · [\d,]+ chars · summarized:\nROW-SUMMARY/);
  assert.match(text, /match in file-z11\.txt/); // tail verbatim
  assert.doesNotMatch(text, /match in file-g0\.txt/); // row content replaced
  assert.match(text, /cwd: \/home\/kenan/);
  // failure path: drop the row summary
  summaries.delete(rowChunk.hash);
  assert.match(renderCondensed(segments, 4000, summaries, "f", header), /\[chunk not summarized · first 800 chars follow]/);
});

test("summary db stores and looks up by hash", () => {
  const dir = mkdtempSync(join(tmpdir(), "condenser-"));
  try {
    const db = openSummaryDb(join(dir, "nested", "summaries.sqlite3"));
    storeSummary(db, { hash: "h1", kind: "row", chars: 9, model: "openai-codex/gpt-5.6-sol", summary: "short" });
    const found = lookupSummaries(db, ["h1", "h2"]);
    assert.equal(found.get("h1").summary, "short");
    assert.equal(found.has("h2"), false);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
