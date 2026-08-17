#!/usr/bin/env node
// The GPT-5.6 Pro question queue. Anyone drops a fully-assembled, text-only
// prompt into the queue; the standing `pro-questions` orchestrator lane claims
// one per available entitlement and submits it as the literal Pro prompt.
// Verified responses land in the run ledger and the provider audit trail.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { browserPoolCapacitySnapshot } from "../extensions/chatgpt-pro/browser.mjs";

const DATA = process.env.AGENT_ORCHESTRATOR_DATA ?? path.join(os.homedir(), "data/agent-orchestrator");
const BASE = path.join(DATA, "pro", "questions");
export const QUEUE = path.join(BASE, "queue");
export const CLAIMED = path.join(BASE, "claimed");
export const DONE = path.join(BASE, "done");
const DB_PATH = path.join(DATA, "orchestrator.sqlite3");

function ensure() {
  for (const dir of [QUEUE, CLAIMED, DONE]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function queued() {
  ensure();
  return fs.readdirSync(QUEUE).filter((name) => name.endsWith(".md")).sort();
}

// claimed/<questionId>.<runId>.md — the run id is the custody link.
function claimedEntries() {
  ensure();
  return fs.readdirSync(CLAIMED).filter((name) => name.endsWith(".md")).map((name) => {
    const stem = name.slice(0, -3);
    const separator = stem.lastIndexOf(".");
    return { name, questionId: stem.slice(0, separator), runId: stem.slice(separator + 1) };
  });
}

// A claimed question whose run ended with a recorded summary carries a
// verified Pro response: move it to done. A run that ended without one failed
// before verification: requeue the question for the next entitlement.
export function reap(db = null) {
  const entries = claimedEntries();
  if (!entries.length) return { done: 0, requeued: 0 };
  const database = db ?? new DatabaseSync(DB_PATH, { readOnly: true });
  let doneCount = 0;
  let requeued = 0;
  try {
    for (const entry of entries) {
      const run = database.prepare("SELECT status, summary FROM run WHERE id=?").get(entry.runId);
      if (!run || run.status === "running") continue;
      const source = path.join(CLAIMED, entry.name);
      if (run.summary) {
        fs.renameSync(source, path.join(DONE, entry.name));
        doneCount += 1;
      } else {
        fs.renameSync(source, path.join(QUEUE, `${entry.questionId}.md`));
        requeued += 1;
      }
    }
  } finally {
    if (!db) database.close();
  }
  return { done: doneCount, requeued };
}

function probe() {
  reap();
  const pending = queued();
  if (!pending.length) {
    console.log("queue empty");
    return 1;
  }
  const capacity = browserPoolCapacitySnapshot(null, Date.now());
  if (capacity.available < 1) {
    console.log(`queued=${pending.length} but no Pro entitlement available (${capacity.inFlight}/${capacity.maxParallel} in flight, ${capacity.eligible} eligible)`);
    return 1;
  }
  console.log(`queued=${pending.length} available=${capacity.available}`);
  return 0;
}

function claim() {
  const runId = process.env.ORCHESTRATOR_RUN_ID;
  if (!runId) {
    console.error("claim requires ORCHESTRATOR_RUN_ID");
    return 2;
  }
  reap();
  const [first] = queued();
  if (!first) return 1;
  const questionId = first.slice(0, -3);
  const target = path.join(CLAIMED, `${questionId}.${runId}.md`);
  try {
    fs.renameSync(path.join(QUEUE, first), target);
  } catch {
    return 1;
  }
  process.stdout.write(fs.readFileSync(target, "utf8").trim());
  return 0;
}

function add(source, id) {
  ensure();
  const text = (source === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(source, "utf8")).trim();
  if (!text) throw new Error("question prompt is empty");
  const questionId = (id ?? path.basename(source, ".md")).replace(/[^A-Za-z0-9._-]/g, "-");
  const target = path.join(QUEUE, `${questionId}.md`);
  if (fs.existsSync(target)) throw new Error(`question already queued: ${questionId}`);
  fs.writeFileSync(target, `${text}\n`, { mode: 0o600 });
  console.log(`queued ${questionId} (${text.length} chars)`);
  return 0;
}

function list() {
  reap();
  for (const [label, dir] of [["queue", QUEUE], ["claimed", CLAIMED], ["done", DONE]]) {
    const names = fs.readdirSync(dir).filter((name) => name.endsWith(".md")).sort();
    console.log(`${label} (${names.length}):${names.length ? "" : " -"}`);
    for (const name of names) console.log(`  ${name}`);
  }
  return 0;
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "probe") return probe();
  if (command === "claim") return claim();
  if (command === "list") return list();
  if (command === "reap") { const result = reap(); console.log(JSON.stringify(result)); return 0; }
  if (command === "add") {
    const idFlag = rest.indexOf("--id");
    const id = idFlag >= 0 ? rest[idFlag + 1] : undefined;
    const source = rest.find((value, index) => index !== idFlag && index !== idFlag + 1);
    if (!source) { console.error("add requires a prompt file path or '-'"); return 2; }
    return add(source, id);
  }
  console.log("Usage: pro-questions.mjs add FILE|- [--id NAME] | probe | claim | list | reap");
  return command ? 2 : 0;
}

const invoked = process.argv[1] && fs.existsSync(process.argv[1]) ? fs.realpathSync(process.argv[1]) : null;
if (invoked === fileURLToPath(import.meta.url)) process.exitCode = main();
