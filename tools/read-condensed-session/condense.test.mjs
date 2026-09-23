import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activePath,
  buildEpisodes,
  contextThrough,
  episodeJobs,
  flattenPath,
  itemsSince,
  hashBlock,
  hashJob,
  lookupSummaries,
  markVerbatim,
  openSummaryDb,
  parseSession,
  pass1Jobs,
  renderCondensed,
  storeSummary,
} from "./condense.mjs";
import { promptForJob } from "./prompts.mjs";

const entry = (id, parentId, message) => ({ type: "message", id, parentId, timestamp: "2026-08-25T10:00:00.000Z", message });
const big = (seed) => seed.repeat(2000); // 10k chars for 5-char seeds
const header = { type: "session", version: 3, id: "s1", timestamp: "2026-08-25T10:00:00.000Z", cwd: "/home/kenan" };

function grind(lines, fromId, calls, tag, resultPad = 60) {
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
      content: [{ type: "text", text: `match in file-${tag}${i}.txt ` + "pad ".repeat(resultPad) }], isError: false,
      timestamp: 1787630000001 + i,
    }));
    parent = resultId;
  }
  return parent;
}

/** user → reply with large thinking → grind → reply → user → recent tail */
function fixture({ grindCalls = 20, tailCalls = 12, thinking = big("deep!") } = {}) {
  const lines = [header];
  lines.push(entry("u1", null, { role: "user", content: [{ type: "text", text: "prove the lemma" }], timestamp: 1787629999000 }));
  lines.push(entry("a1", "u1", {
    role: "assistant", model: "claude-opus-5",
    content: [{ type: "thinking", thinking }, { type: "text", text: "Starting the census now." }],
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
  const lines = fixture().split("\n").map((line) => JSON.parse(line));
  lines.splice(3, 0, { type: "message", id: "dead", parentId: "u1", timestamp: "x", message: { role: "assistant", content: [{ type: "text", text: "ABANDONED" }] } });
  const path = activePath(lines.filter((line) => line.id));
  assert.equal(path.some((candidate) => candidate.id === "dead"), false);
  assert.equal(path.at(-1).id, "end");
});

test("since windows exclude old activity and report their exact upper bound", () => {
  const items = flattenPath(activePath(parseSession(fixture({ grindCalls: 2, tailCalls: 2 }))));
  const since = 1787630000001;
  const window = itemsSince(items, since);
  assert.ok(window.length > 0);
  assert.ok(window.every((item) => Number(item.time) >= since));
  assert.equal(contextThrough(window, since), Math.max(...window.map((item) => Number(item.time))));
  assert.equal(itemsSince(items, Date.UTC(2030, 0, 1)).length, 0);
});

test("durable anchors and the ten-call recent tail are retained", () => {
  const items = itemsOf(fixture());
  for (const item of items.filter((candidate) => candidate.kind === "user")) assert.ok(item.anchor && item.verbatim);
  assert.ok(items.find((item) => item.text.startsWith("Census done")).anchor);
  assert.ok(!items.find((item) => item.text.startsWith("Starting the census")).anchor);
  const tailCalls = items.filter((item) => item.kind === "toolCall" && item.tail);
  assert.equal(tailCalls.length, 10);
  const oldCalls = items.filter((item) => item.kind === "toolCall" && item.text.includes("pattern-g"));
  assert.ok(oldCalls.every((item) => !item.verbatim));
});

test("pass 1 takes large non-verbatim blocks and hashes the exact prompt", () => {
  const text = "deep!".repeat(4000); // 20k
  const items = itemsOf(fixture({ thinking: text }));
  const jobs = pass1Jobs(items, 16_000);
  assert.deepEqual(jobs.map((job) => job.kind), ["thinking"]);
  assert.equal(jobs[0].hash, hashBlock(promptForJob("thinking", text)));
  assert.equal(jobs[0].hash, hashJob("thinking", text));
  assert.notEqual(hashJob("thinking", text), hashJob("block", text));
  assert.equal(pass1Jobs(items, 16_000).length, 1);
});

test("episodes span durable anchors and absorb pass-1 summaries", () => {
  const source = "deep!".repeat(4000);
  const items = itemsOf(fixture({ thinking: source }));
  const pass1 = pass1Jobs(items, 16_000);
  const summaries = new Map([[pass1[0].hash, { summary: "DEEP-SUMMARY" }]]);
  const segments = buildEpisodes(items, 16_000, summaries);
  const episodes = segments.filter((segment) => segment.type === "episode");
  assert.equal(episodes.length, 1);
  const input = episodes[0].chunks[0].text;
  assert.match(input, /context before the episode \(do not summarize\)[\s\S]*prove the lemma/);
  assert.match(input, /thinking · 20,000 source chars · pre-summarized\]\nDEEP-SUMMARY/);
  assert.match(input, /→ bash\(\{"command":"grep pattern-g0"\}\)/);
  assert.match(input, /\[assistant text\]\nStarting the census now\./);
  assert.match(input, /context after the episode \(do not summarize\)[\s\S]*Census done: 42 groups verified/);
  assert.equal(episodeJobs(segments).length, 1);
  assert.doesNotMatch(input, new RegExp(source.slice(0, 100)));
});

test("small anchor-to-anchor stretches stay readable without model calls", () => {
  const tiny = [header,
    entry("u1", null, { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 }),
    entry("a1", "u1", { role: "assistant", content: [{ type: "thinking", thinking: "hm" }, { type: "text", text: "hello" }], timestamp: 2 }),
    entry("u2", "a1", { role: "user", content: [{ type: "text", text: "bye" }], timestamp: 3 }),
  ].map((line) => JSON.stringify(line)).join("\n");
  const segments = buildEpisodes(itemsOf(tiny), 16_000, new Map());
  assert.equal(segments.filter((segment) => segment.type === "episode").length, 0);
  assert.equal(episodeJobs(segments).length, 0);
});

test("episode chunks honor represented-mass limit and retain source accounting", () => {
  const items = [
    { kind: "user", text: "start", chars: 5, time: 1, anchor: true, verbatim: true, tail: false },
    { kind: "thinking", text: "a".repeat(900), chars: 900, time: 2, anchor: false, verbatim: false, tail: false },
    { kind: "toolResult", toolName: "bash", text: "b".repeat(900), chars: 900, time: 3, anchor: false, verbatim: false, tail: false },
    { kind: "text", text: "answer", chars: 6, time: 4, anchor: true, verbatim: true, tail: false },
  ];
  const episode = buildEpisodes(items, 500, new Map(), 1_000).find((segment) => segment.type === "episode");
  assert.equal(episode.chunks.length, 2);
  assert.equal(episode.chunks.reduce((total, chunk) => total + chunk.chars, 0), 1_800);
  assert.equal(episodeJobs([episode]).length, 2);
});

test("settled episode hashes survive later session growth", () => {
  const source = "deep!".repeat(4000);
  const baseItems = itemsOf(fixture({ grindCalls: 20, tailCalls: 12, thinking: source }));
  const pass1 = pass1Jobs(baseItems, 16_000);
  const summaries = new Map([[pass1[0].hash, { summary: "DEEP-SUMMARY" }]]);
  const baseEpisode = buildEpisodes(baseItems, 16_000, summaries).find((segment) => segment.type === "episode");

  const grownItems = itemsOf(fixture({ grindCalls: 20, tailCalls: 40, thinking: source }));
  pass1Jobs(grownItems, 16_000);
  const grownEpisode = buildEpisodes(grownItems, 16_000, summaries).find((segment) => segment.type === "episode");
  assert.equal(grownEpisode.chunks[0].hash, baseEpisode.chunks[0].hash);
});

test("render keeps anchors, emits episode summaries, caps large recent bodies, and marks failures", () => {
  const source = "deep!".repeat(4000);
  const items = itemsOf(fixture({ thinking: source }));
  const pass1 = pass1Jobs(items, 16_000);
  const summaries = new Map([[pass1[0].hash, { summary: "DEEP-SUMMARY" }]]);
  const segments = buildEpisodes(items, 16_000, summaries);
  const episode = segments.find((segment) => segment.type === "episode");
  summaries.set(episode.chunks[0].hash, { summary: "EPISODE-SUMMARY" });
  const text = renderCondensed(segments, 16_000, summaries, "fixture.jsonl", header);
  assert.match(text, /user:\nprove the lemma/);
  assert.match(text, /Census done: 42 groups verified/);
  assert.match(text, /condensed episode · \d+ blocks \(20 tool calls\) · [\d,]+ source chars · 1 summary chunk:\nEPISODE-SUMMARY/);
  assert.match(text, /match in file-z11\.txt/);
  assert.doesNotMatch(text, /match in file-g0\.txt/);
  assert.match(text, /cwd: \/home\/kenan/);

  const longTailResult = items.find((item) => item.kind === "toolResult" && item.tail);
  longTailResult.text = "TAIL".repeat(1_000);
  longTailResult.chars = longTailResult.text.length;
  assert.match(renderCondensed(segments, 16_000, summaries, "f", header), /4,000 chars in recent body; capped/);

  summaries.delete(episode.chunks[0].hash);
  assert.match(renderCondensed(segments, 16_000, summaries, "f", header), /\[chunk not summarized · first 800 chars follow\]/);
});

test("summary database stores and retrieves prompt-addressed records", () => {
  const dir = mkdtempSync(join(tmpdir(), "condenser-"));
  try {
    const db = openSummaryDb(join(dir, "nested", "summaries.sqlite3"));
    const hash = hashJob("episode", "source");
    storeSummary(db, { hash, kind: "episode", chars: 9, model: "openai-codex/gpt-6-astra", summary: "short" });
    const found = lookupSummaries(db, [hash, "absent"]);
    assert.equal(found.get(hash).summary, "short");
    assert.equal(found.has("absent"), false);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
