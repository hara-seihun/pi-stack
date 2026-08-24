import { Database } from "bun:sqlite";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  summarizeAgentRun, tailRange, TranscriptBuffer,
  type AgentHostRef, type AgentLiveState, type AgentRunEvent, type AgentRunRow, type AgentRunSummary,
} from "./agent-runs";
import type { ProviderManifest } from "./provider-manifest";

// An agent host is one machine running pi-orchestrator: a SQLite run ledger and
// a directory of per-run transcripts. Local and SSH-backed hosts follow the
// same rules, so one list answers which agents are working across the fleet.

export interface LedgerListing {
  runs: AgentRunRow[];
  running: number;
  models: Array<{ model: string; count: number }>;
}

export interface LedgerTail {
  run: AgentRunRow | null;
  size: number;
  offset: number;
  next: number;
  chunk: string;
}

export interface AgentLedger {
  list(limit: number): Promise<LedgerListing>;
  tail(runId: string, offset: number, maxBytes: number, watch: boolean): Promise<LedgerTail>;
  close(): void;
}

const RUNS_QUERY = "SELECT * FROM run WHERE state='running' ORDER BY started_at DESC LIMIT ?";
const RUNNING_QUERY = "SELECT count(*) count FROM run WHERE state='running'";
const MODELS_QUERY = "SELECT model, count(*) count FROM run WHERE state='running' GROUP BY model";
const RUN_QUERY = "SELECT * FROM run WHERE id=?";

// A chunk handed to a transcript buffer must begin and end on line boundaries:
// a reader that joined a long transcript mid-line drops that fragment, and a
// read truncated by the byte budget stops at the last complete line. A single
// line longer than the whole budget is skipped rather than stalling the cursor.
export function alignTail(data: Buffer, start: number, end: number, size: number, fresh: boolean): { chunk: string; offset: number; next: number } {
  let body = data;
  let offset = start;
  if (fresh && start > 0) {
    const newline = body.indexOf(0x0a);
    if (newline < 0) return { chunk: "", offset: end, next: end };
    body = body.subarray(newline + 1);
    offset = start + newline + 1;
  }
  if (end < size) {
    const newline = body.lastIndexOf(0x0a);
    if (newline < 0) return { chunk: "", offset, next: end };
    body = body.subarray(0, newline + 1);
  }
  return { chunk: body.toString("utf8"), offset, next: offset + body.length };
}

function liveState(directory: string): AgentLiveState | null {
  try { return JSON.parse(readFileSync(join(directory, "live.json"), "utf8")); }
  catch { return null; }
}

// Touching `watch` is the only write Pi Remote makes into orchestrator state:
// it tells the owning agent host that partial output is worth publishing.
function markWatched(directory: string) {
  if (!existsSync(directory)) return;
  const marker = join(directory, "watch");
  try {
    if (existsSync(marker)) {
      const stamp = new Date();
      utimesSync(marker, stamp, stamp);
    } else {
      mkdirSync(directory, { recursive: true });
      writeFileSync(marker, "", { mode: 0o600 });
    }
  } catch { /* Observation must never break on a read-only or purged run. */ }
}

export class LocalLedger implements AgentLedger {
  private readonly database: Database;
  private readonly owned: boolean;

  constructor(database: Database | string, private readonly runsRoot: string) {
    this.owned = typeof database === "string";
    this.database = typeof database === "string"
      ? new Database(database, { readonly: true, strict: true })
      : database;
    if (this.owned) this.database.exec("PRAGMA busy_timeout=5000;");
  }

  async list(limit: number): Promise<LedgerListing> {
    const runs = (this.database.query(RUNS_QUERY).all(limit) as any[]).map((row) => this.decorate(row));
    return {
      runs,
      running: Number((this.database.query(RUNNING_QUERY).get() as any)?.count ?? 0),
      models: (this.database.query(MODELS_QUERY).all() as any[]).map((row) => ({ model: String(row.model ?? "unknown"), count: Number(row.count) })),
    };
  }

  async tail(runId: string, offset: number, maxBytes: number, watch: boolean): Promise<LedgerTail> {
    const row = this.database.query(RUN_QUERY).get(runId) as any;
    const directory = join(this.runsRoot, runId);
    const file = join(directory, "events.jsonl");
    let size = -1;
    try { size = statSync(file).size; } catch {}
    const range = tailRange(Math.max(0, size), offset, maxBytes);
    let data = Buffer.alloc(0);
    if (range.end > range.start) {
      const handle = openSync(file, "r");
      try {
        const buffer = Buffer.allocUnsafe(range.end - range.start);
        const read = readSync(handle, buffer, 0, buffer.length, range.start);
        data = buffer.subarray(0, read);
      } finally { closeSync(handle); }
    }
    if (watch && row?.state === "running") markWatched(directory);
    return {
      run: row ? this.decorate(row) : null,
      size: Math.max(0, size),
      ...alignTail(data, range.start, range.end, Math.max(0, size), range.fresh),
    };
  }

  close() { if (this.owned) this.database.close(); }

  private decorate(row: any): AgentRunRow {
    const directory = join(this.runsRoot, String(row.id));
    return { ...row, observable: existsSync(join(directory, "events.jsonl")), live: liveState(directory) };
  }
}

// The same rules, executed on the host that owns the ledger. One round trip
// answers a whole poll: the ledger rows, the transcript slice, the live tail,
// and the watch marker. The script is fed on stdin so no ledger path, run id,
// or byte offset is ever interpolated into a shell command.
export const REMOTE_SCRIPT = String.raw`
import base64, json, os, sqlite3, sys

mode, ledger, runs_root = sys.argv[1], sys.argv[2], sys.argv[3]
connection = sqlite3.connect("file:" + ledger + "?mode=ro", uri=True, timeout=5)
connection.row_factory = sqlite3.Row

def live(directory):
    try:
        with open(os.path.join(directory, "live.json"), "r") as handle:
            return json.load(handle)
    except Exception:
        return None

def decorate(row):
    item = {key: row[key] for key in row.keys()}
    directory = os.path.join(runs_root, str(item["id"]))
    item["observable"] = os.path.exists(os.path.join(directory, "events.jsonl"))
    item["live"] = live(directory)
    return item

if mode == "list":
    limit = int(sys.argv[4])
    runs = [decorate(row) for row in connection.execute(
        "SELECT * FROM run WHERE state='running' ORDER BY started_at DESC LIMIT ?", (limit,))]
    running = connection.execute("SELECT count(*) FROM run WHERE state='running'").fetchone()[0]
    models = [{"model": row[0], "count": row[1]} for row in connection.execute(
        "SELECT model, count(*) FROM run WHERE state='running' GROUP BY model")]
    print(json.dumps({"runs": runs, "running": running, "models": models}))
    sys.exit(0)

run_id, offset, max_bytes, watch = sys.argv[4], int(sys.argv[5]), int(sys.argv[6]), sys.argv[7] == "1"
row = connection.execute("SELECT * FROM run WHERE id=?", (run_id,)).fetchone()
run = decorate(row) if row is not None else None
directory = os.path.join(runs_root, run_id)
path = os.path.join(directory, "events.jsonl")
try:
    size = os.path.getsize(path)
except OSError:
    size = 0

fresh = offset < 0 or offset > size
start = max(0, size - max_bytes) if fresh else offset
end = min(size, start + max_bytes)
data = b""
if end > start:
    with open(path, "rb") as handle:
        handle.seek(start)
        data = handle.read(end - start)

if fresh and start > 0:
    newline = data.find(b"\n")
    if newline < 0:
        data, start = b"", end
    else:
        data, start = data[newline + 1:], start + newline + 1
next_offset = start + len(data)
if end < size:
    newline = data.rfind(b"\n")
    if newline < 0:
        data, next_offset = b"", end
    else:
        data = data[:newline + 1]
        next_offset = start + len(data)

if watch and run is not None and run.get("state") == "running" and os.path.isdir(directory):
    marker = os.path.join(directory, "watch")
    try:
        with open(marker, "a"):
            pass
        os.chmod(marker, 0o600)
        os.utime(marker, None)
    except OSError:
        pass

print(json.dumps({
    "run": run, "size": size, "offset": start, "next": next_offset,
    "chunk": base64.b64encode(data).decode("ascii"),
}))
`;

export type RemoteRunner = (args: string[], timeoutMs: number) => Promise<string>;

export function sshRunner(ssh: string): RemoteRunner {
  return async (args, timeoutMs) => {
    const command = `python3 - ${args.map((value) => `'${value.replaceAll("'", `'"'"'`)}'`).join(" ")}`;
    const proc = Bun.spawn(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", ssh, command], {
      stdin: Buffer.from(REMOTE_SCRIPT),
      stdout: "pipe",
      stderr: "pipe",
    });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; proc.kill(); }, timeoutMs);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
      ]);
      if (timedOut) throw new Error(`${ssh} did not answer within ${Math.round(timeoutMs / 1000)}s`);
      if (code !== 0) throw new Error(stderr.trim().split("\n").at(-1) || `${ssh} query exited ${code}`);
      return stdout;
    } finally { clearTimeout(timer); }
  };
}

export class RemoteLedger implements AgentLedger {
  constructor(
    private readonly ledgerPath: string,
    private readonly runsRoot: string,
    private readonly run: RemoteRunner,
    private readonly timeoutMs = 10_000,
  ) {}

  async list(limit: number): Promise<LedgerListing> {
    const payload = JSON.parse(await this.run(["list", this.ledgerPath, this.runsRoot, String(limit)], this.timeoutMs));
    return {
      runs: (payload.runs ?? []) as AgentRunRow[],
      running: Number(payload.running ?? 0),
      models: (payload.models ?? []).map((row: any) => ({ model: String(row.model ?? "unknown"), count: Number(row.count) })),
    };
  }

  async tail(runId: string, offset: number, maxBytes: number, watch: boolean): Promise<LedgerTail> {
    const payload = JSON.parse(await this.run(
      ["tail", this.ledgerPath, this.runsRoot, runId, String(offset), String(maxBytes), watch ? "1" : "0"],
      this.timeoutMs,
    ));
    return {
      run: (payload.run ?? null) as AgentRunRow | null,
      size: Number(payload.size ?? 0),
      offset: Number(payload.offset ?? 0),
      next: Number(payload.next ?? 0),
      chunk: Buffer.from(String(payload.chunk ?? ""), "base64").toString("utf8"),
    };
  }

  close() {}
}

export interface AgentHostSnapshot {
  runs: AgentRunSummary[];
  running: number;
  models: Array<{ model: string; count: number }>;
  updatedAt: string | null;
  error: string | null;
}

export interface AgentHostOptions {
  key: string;
  label: string;
  name: string;
  manifest: ProviderManifest;
  /** How long a listing may be served before a refresh is started. */
  maxAgeMs?: number;
  runningLimit?: number;
  maxTailBytes?: number;
  maxWatchedRuns?: number;
}

const DEFAULT_TAIL_BYTES = 256 * 1024;

export class AgentHost {
  readonly ref: AgentHostRef;
  private readonly buffers = new Map<string, TranscriptBuffer>();
  private snapshot: AgentHostSnapshot = { runs: [], running: 0, models: [], updatedAt: null, error: null };
  private fetchedAt = 0;
  private inflight: Promise<void> | null = null;

  constructor(private readonly ledger: AgentLedger, private readonly options: AgentHostOptions) {
    this.ref = { key: options.key, label: options.label, name: options.name };
  }

  get key(): string { return this.options.key; }

  // A listing that has never been read is awaited, because a client asking for
  // the agent list must not be told there are none. Afterwards a stale listing
  // is served immediately while its refresh runs, so a slow or unreachable host
  // can never stall this machine's own drawer.
  async runs(maxAgeMs = this.options.maxAgeMs ?? 0): Promise<AgentHostSnapshot> {
    if (!this.fetchedAt) await this.refresh();
    else if (Date.now() - this.fetchedAt >= maxAgeMs) void this.refresh();
    return this.snapshot;
  }

  cached(): AgentHostSnapshot { return this.snapshot; }

  refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      const at = Date.now();
      try {
        const listing = await this.ledger.list(this.options.runningLimit ?? 400);
        this.snapshot = {
          runs: listing.runs.map((row) => summarizeAgentRun(row, this.options.manifest, this.ref, at)),
          running: listing.running,
          models: listing.models,
          updatedAt: new Date(at).toISOString(),
          error: null,
        };
      } catch (cause: any) {
        this.snapshot = { ...this.snapshot, error: cause?.message ?? `${this.options.name} agents unavailable` };
      } finally {
        this.fetchedAt = Date.now();
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  async events(runId: string, after: number, { watch = true } = {}): Promise<{
    run: AgentRunSummary | null;
    events: AgentRunEvent[];
    liveText: string;
    liveThinking: string;
  }> {
    const buffer = this.buffer(runId);
    const tail = await this.ledger.tail(runId, buffer.touchedAt ? buffer.offset : -1, this.options.maxTailBytes ?? DEFAULT_TAIL_BYTES, watch);
    buffer.touchedAt = Date.now();
    if (tail.offset !== buffer.offset) buffer.reset(tail.offset);
    buffer.offset = tail.next;
    if (tail.chunk) buffer.append(tail.chunk);
    const run = tail.run ? summarizeAgentRun(tail.run, this.options.manifest, this.ref) : null;
    const live = run?.status === "running" ? tail.run?.live ?? null : null;
    return {
      run,
      events: buffer.slice(after),
      liveText: String(live?.liveText ?? ""),
      liveThinking: String(live?.liveThinking ?? ""),
    };
  }

  close() { this.ledger.close(); }

  private buffer(runId: string): TranscriptBuffer {
    let buffer = this.buffers.get(runId);
    if (!buffer) {
      buffer = new TranscriptBuffer();
      this.buffers.set(runId, buffer);
      const limit = this.options.maxWatchedRuns ?? 12;
      while (this.buffers.size > limit) {
        const oldest = [...this.buffers.entries()].sort((left, right) => left[1].touchedAt - right[1].touchedAt)[0];
        if (!oldest || oldest[0] === runId) break;
        this.buffers.delete(oldest[0]);
      }
    }
    return buffer;
  }
}
