import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const repetitions = Number(process.argv[4]);
if (!process.argv[2] || !process.argv[3] || !Number.isInteger(repetitions) || repetitions < 3 || repetitions > 100)
  throw new Error("Usage: bun transcript-locator-bench.ts /absolute/server/source-transcripts.ts /own/fixture/root REPETITIONS(3..100)");
const { SourceTranscripts } = await import(resolve(process.argv[2]));
const directory = mkdtempSync(join(resolve(process.argv[3]), "transcript-locator-bench-"));
const db = new Database(join(directory, "fixture.sqlite"));
try {
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
  const records = Array.from({ length: 60 }, (_,seq) => ({ seq, count: 1, entryId: String(seq),
    message: { role: "user", timestamp: seq + 1, content: `Synthetic locator fixture ${seq}` }, results: [] }));
  const source = new SourceTranscripts(db, async () => ({ ok: true, value: {
    source: { revision: "fixture", generation: "fixture", context: "synthetic" }, total: 60, records,
  } }), (_id: string, message: unknown) => message, () => "/fixture/image");
  const samples: number[] = [];
  for (let index = 0; index < repetitions; index++) {
    const start = performance.now();
    const result = await source.page("fixture", undefined, 60);
    if (!result.ok) throw new Error(result.error.message);
    if (result.value.items.length !== 60) throw new Error("The benchmark did not return 60 heads");
    samples.push(performance.now() - start);
  }
  const warm = [...samples.slice(1)].sort((a,b) => a - b);
  console.log(JSON.stringify({ samples_ms: samples, cold_ms: samples[0], warm_p50_ms: warm[Math.floor(warm.length / 2)],
    warm_p95_ms: warm[Math.ceil(warm.length * .95) - 1], locator_rows: db.query("SELECT count(*) AS n FROM transcript_locators").get() }, null, 2));
} finally {
  db.close();
  rmSync(directory, { recursive: true, force: true });
}
