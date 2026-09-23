import { Database } from "bun:sqlite";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { VoiceBroker } from "./broker";
import { LIVE_MODEL, LIVE_VOICE } from "./protocol";

const credentialDirectory = process.env.CREDENTIALS_DIRECTORY;
const stateDirectory = process.env.STATE_DIRECTORY;
if (!credentialDirectory || !stateDirectory) throw new Error("Run the Voice service with its systemd credential and state directories");
const broker = new VoiceBroker(join(credentialDirectory, "openai-api-key"));
const db = new Database(join(stateDirectory, "sessions.sqlite3"));
db.exec(`PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, thread_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL, closed INTEGER NOT NULL DEFAULT 0,
    seconds REAL NOT NULL DEFAULT 0, finalized INTEGER NOT NULL DEFAULT 0, error TEXT
  );`);
const releaseFile = new URL("../../.pi-stack-commit", import.meta.url);
const releaseCommit = existsSync(releaseFile) ? readFileSync(releaseFile, "utf8").trim() : null;
const closing = new Map<string, Promise<Response>>();
const json = (value: unknown, status = 200) => Response.json(value, { status });
const failure = (error: string, status = 400) => json({ error }, status);

function close(id: string): Promise<Response> {
  const pending = closing.get(id);
  if (pending) return pending;
  const operation = broker.close(id).then((result) => {
    if (result.ok) {
      db.query("UPDATE sessions SET closed=1,error=NULL WHERE id=?").run(id);
      return json(result.value);
    }
    db.query("UPDATE sessions SET expires_at=?,error=? WHERE id=?").run(Date.now() + 60_000, result.error, id);
    console.error(`Voice session ${id}: ${result.error}`);
    return failure(result.error, result.status);
  }).finally(() => closing.delete(id));
  closing.set(id, operation);
  return operation;
}

const reaper = setInterval(() => {
  for (const row of db.query("SELECT id FROM sessions WHERE closed=0 AND expires_at<?").all(Date.now()) as { id: string }[]) void close(row.id);
}, 5_000);
reaper.unref();

Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PI_STACK_VOICE_PORT ?? "8796"),
  maxRequestBodySize: 256 * 1024,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/status") return json({ enabled: true, model: LIVE_MODEL, voice: LIVE_VOICE, releaseCommit });
    let body: Record<string, any>;
    try { body = await req.json(); } catch { return failure("JSON request required"); }
    if (!body || typeof body.owner !== "string" || typeof body.threadId !== "string") return failure("Voice owner and Pi thread are required");
    if (req.method === "POST" && url.pathname === "/sessions") {
      if (typeof body.sdp !== "string" || typeof body.instructions !== "string") return failure("SDP and instructions are required");
      const result = await broker.negotiate(body.sdp, body.instructions);
      if (!result.ok) return failure(result.error, result.status);
      db.query("INSERT INTO sessions(id,owner,thread_id,expires_at) VALUES(?,?,?,?)")
        .run(result.value.session.id, body.owner, body.threadId, Date.now() + 90_000);
      return json(result.value, 201);
    }
    const match = /^\/sessions\/([^/]+)$/.exec(url.pathname);
    if (!match) return failure("Unknown Voice operation", 404);
    const id = decodeURIComponent(match[1]!);
    const row = db.query("SELECT closed,seconds FROM sessions WHERE id=? AND owner=? AND thread_id=?")
      .get(id, body.owner, body.threadId) as { closed: number; seconds: number } | null;
    if (!row) return failure("Voice session not found", 404);
    if (req.method === "PATCH") {
      const seconds = Number(body.seconds);
      if (!Number.isFinite(seconds) || seconds < 0) return failure("Cumulative voice seconds required");
      db.query("UPDATE sessions SET expires_at=?,seconds=MAX(seconds,?),closed=MAX(closed,?),finalized=MAX(finalized,?),error=NULL WHERE id=?")
        .run(Date.now() + 90_000, seconds, body.finalized === true ? 1 : 0, body.finalized === true ? 1 : 0, id);
      return json({ ok: true });
    }
    if (req.method === "DELETE") return row.closed ? json({ seconds: row.seconds }) : close(id);
    return failure("Unknown Voice operation", 404);
  },
});
if (process.env.NOTIFY_SOCKET) {
  const ready = Bun.spawnSync(["systemd-notify", "--ready"]);
  if (ready.exitCode !== 0) throw new Error("Could not notify the Voice service owner");
}
