#!/usr/bin/env node
/**
 * Distills a run transcript (events.jsonl, see src/host/transcript.ts) into
 * the behavioural skeleton the continuation tests replay: check-in
 * boundaries (user messages), tool starts with just enough of their
 * arguments for the ShiftObserver's own parsers to run against real data,
 * and the closing notices that record how the shift actually halted.
 * Everything else — thinking, assistant prose, tool output — is dropped.
 *
 * The committed fixtures under this directory were distilled from the
 * fleet's real transcripts of the night of 2026-08-21/22 (runs directory
 * /var/lib/pi-orchestrator/runs on gmktec; transcripts are pruned after a
 * week, so the fixtures are the durable copy). Regenerate with:
 *
 *   node distill.mjs /path/to/runs/<runId>/events.jsonl > <fixture>.jsonl
 */
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";

const [path] = process.argv.slice(2);
if (path === undefined) {
  console.error("usage: distill.mjs <events.jsonl>");
  process.exit(1);
}

/** Keep each math_submit call site with enough surrounding code for the
 * observer's kind/title extraction; drop the rest of the script. */
function reduceCode(code) {
  const kept = [];
  const pattern = /math_submit/g;
  for (const match of code.matchAll(pattern)) {
    kept.push(code.slice(Math.max(0, match.index - 80), match.index + 700));
  }
  return kept.join("\n/* … */\n");
}

function reduceArgs(name, args) {
  if (args === null || typeof args !== "object") return {};
  if (name === "task_complete") {
    return { complete: args.complete, productive: args.productive };
  }
  if (name === "mcp") {
    if (args.tool !== "math_submit") return { tool: args.tool };
    let inner = args.args;
    if (typeof inner === "string") {
      try {
        inner = JSON.parse(inner);
      } catch {
        inner = undefined;
      }
    }
    return { tool: "math_submit", args: { kind: inner?.kind, title: inner?.title } };
  }
  if (typeof name === "string" && name.toLowerCase().includes("script")) {
    return { code: reduceCode(String(args.code ?? "")) };
  }
  return {};
}

const lines = createInterface({ input: createReadStream(path) });
for await (const line of lines) {
  if (line.trim() === "") continue;
  const event = JSON.parse(line);
  switch (event.type) {
    case "user":
      console.log(
        JSON.stringify({
          type: "user",
          time: event.time,
          payload: { text: String(event.payload?.text ?? "").slice(0, 160) },
        }),
      );
      break;
    case "tool_start": {
      const name = String(event.payload?.name ?? "tool");
      console.log(
        JSON.stringify({
          type: "tool_start",
          time: event.time,
          payload: { name, args: reduceArgs(name, event.payload?.args) },
        }),
      );
      break;
    }
    case "notice":
      console.log(
        JSON.stringify({
          type: "notice",
          time: event.time,
          payload: { text: String(event.payload?.text ?? "").slice(0, 200) },
        }),
      );
      break;
    default:
      break;
  }
}
