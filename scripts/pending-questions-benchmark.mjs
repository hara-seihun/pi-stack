import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";

const path = process.argv[2];
if (!path || process.argv.length !== 3) throw Error("Usage: node scripts/pending-questions-benchmark.mjs OWNER_DATABASE");
const db = new DatabaseSync(path, { readOnly: true });
try {
  db.exec("PRAGMA query_only=ON");
  const current = db.prepare(`SELECT q.* FROM thread_question q JOIN thread t ON t.id=q.thread_id
    WHERE q.accepted_at IS NULL ORDER BY q.thread_id,q.created_at,q.rowid`);
  const owners = db.prepare("SELECT id,title,metadata FROM thread WHERE id IN (SELECT value FROM json_each(?))");
  const events = db.prepare(`SELECT e.seq,q.id AS questionId,q.thread_id AS threadId,q.question,q.created_at AS time,q.accepted_at
    FROM thread_question_event e JOIN thread_question q ON q.id=e.question_id WHERE e.seq>? ORDER BY e.seq LIMIT ?`);
  const threadPage = db.prepare("SELECT id FROM thread ORDER BY created_at,id LIMIT ? OFFSET ?");
  const samples = [];
  let historyRows = 0, historyRequests = 0, directoryRows = 0, directoryRequests = 0, pendingRows = 0, questionOwners = 0;
  for (let run = 0; run < 3; run++) {
    let after = 0, offset = 0;
    historyRows = 0; historyRequests = 0; directoryRows = 0; directoryRequests = 0;
    const oldStart = performance.now();
    for (;;) {
      const rows = events.all(after, 1000); historyRequests++; historyRows += rows.length;
      if (!rows.length) break;
      after = rows.at(-1).seq;
    }
    for (;;) {
      const rows = threadPage.all(100, offset); directoryRequests++; directoryRows += rows.length;
      if (rows.length < 100) break;
      offset += rows.length;
    }
    const historyAndDirectoryMs = performance.now() - oldStart;
    const currentStart = performance.now();
    const rows = current.all();
    const ids = [...new Set(rows.map(row => row.thread_id))];
    const threads = owners.all(JSON.stringify(ids));
    pendingRows = rows.length; questionOwners = threads.length;
    samples.push({ historyAndDirectoryMs, pendingOwnerQueryMs: performance.now() - currentStart });
  }
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT q.* FROM thread_question q JOIN thread t ON t.id=q.thread_id
    WHERE q.accepted_at IS NULL ORDER BY q.thread_id,q.created_at,q.rowid`).all().map(row => row.detail);
  console.log(JSON.stringify({ readOnly: true, historyRows, historyRequests, directoryRows, directoryRequests, pendingRows, questionOwners, currentOwnerRequests: 1, samples, plan }, null, 2));
} finally { db.close(); }
