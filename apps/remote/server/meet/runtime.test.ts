import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectRuntime, meetSocket, runtimeCall, runtimeRevision, runtimeStatus } from "./runtime";
import type { RuntimeRelease, RuntimeRequest, RuntimeStatus } from "./runtime";

async function status(socket: string): Promise<RuntimeStatus> {
  const result = await runtimeStatus(socket);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
async function until<T>(read: () => Promise<T>, accepts: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (accepts(value)) return value;
    if (Date.now() >= deadline) throw new Error("Runtime test condition exceeded five seconds");
    await Bun.sleep(10);
  }
}

test("person-owned worker retains live room, signals and transcript through actual supervisor process replacement; rotation is idle-only", async () => {
  const data = mkdtempSync(join(tmpdir(), "meet-runtime-"));
  const socket = meetSocket(data);
  const config = join(data, "config.json");
  writeFileSync(config, JSON.stringify({ version: 1, environment: {} }));
  const env = { ...process.env, PI_REMOTE_DATA: data, PI_REMOTE_CONFIG: config };
  const fixture = join(import.meta.dir, "fixtures", "runtime-supervisor.ts");
  const supervisor = async (input: unknown) => {
    const child = Bun.spawn([process.execPath, fixture, JSON.stringify(input)], { env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`Supervisor fixture exited ${code}: ${stderr}\n${readFileSync(join(data, "meet-runtime.log"), "utf8")}`);
    return JSON.parse(stdout);
  };
  let current: RuntimeStatus | null = null;
  let streamFinish: (() => void) | null = null;
  const previousData = process.env.PI_REMOTE_DATA;
  const previousConfig = process.env.PI_REMOTE_CONFIG;
  process.env.PI_REMOTE_DATA = data;
  process.env.PI_REMOTE_CONFIG = config;
  try {
    const id = crypto.randomUUID();
    const seeded = await supervisor({ mode: "seed", id, signalId: crypto.randomUUID() });
    current = await status(socket);
    expect(current.pid).toBe(seeded.workerPid);
    expect(current.pid).not.toBe(seeded.supervisorPid);
    expect(current.rooms).toEqual([{ id, sessionId: "thread" }]);
    expect(statSync(socket).mode & 0o777).toBe(0o600);
    const inspected = await supervisor({ mode: "inspect", id, hostId: seeded.result.host.participant.id,
      guestId: seeded.result.guest.participant.id, signalBody: seeded.result.signalBody });
    expect(inspected.supervisorPid).not.toBe(seeded.supervisorPid);
    expect(inspected.workerPid).toBe(seeded.workerPid);
    expect(inspected.instance).toBe(seeded.instance);
    expect(inspected.result.room.apiUrl).toBe(`http://person.example/v1/meet/${id}`);
    expect(inspected.result.room.participants).toEqual([seeded.result.host.participant, seeded.result.guest.participant]);
    expect(inspected.result.room.voiceMuted).toBe(false);
    expect(inspected.result.room.voiceRevision).toBe(3);
    expect(inspected.result.room.threads[0].name).toBe("inspect");
    expect(inspected.result.poll.messages).toHaveLength(1);
    expect(inspected.result.poll.messages[0].signal).toEqual(seeded.result.signalBody.signal);
    expect(inspected.result.repeated.messages).toEqual(inspected.result.poll.messages);
    expect(inspected.result.duplicateCreate.participant).toEqual(seeded.result.host.participant);
    expect(inspected.result.mismatchStatus).toBe(400);
    expect(inspected.result.live).toBe(true);
    expect(inspected.result.meetings[0].endedAt).toBeNull();
    expect(inspected.result.turns[0].text).toBe("Meetings survive the front door.");

    const pinned = await connectRuntime(data, "new-source-revision");
    expect(pinned.ok).toBe(true);
    if (!pinned.ok) throw new Error(pinned.error);
    expect(pinned.value.pid).toBe(current.pid);
    const refused = await runtimeCall<RuntimeRelease>(socket, "/runtime/release", { instance: current.instance });
    expect(refused).toEqual({ ok: true, value: { released: false, reason: "live-rooms" } });
    const left = await supervisor({ mode: "leave", id, hostId: seeded.result.host.participant.id });
    expect(left.workerPid).toBe(current.pid);
    expect(left.result.live).toBe(false);
    expect(left.result.meetings[0].endedAt).toBeNumber();

    // A room appears after an idle status read: release must re-check actual rooms rather than trust that read.
    const idle = await status(socket);
    expect(idle.rooms).toHaveLength(0);
    const racingId = crypto.randomUUID();
    const racing = await supervisor({ mode: "create", id: racingId });
    expect(await runtimeCall(socket, "/runtime/release", { instance: idle.instance }))
      .toEqual({ ok: true, value: { released: false, reason: "live-rooms" } });
    expect((await status(socket)).pid).toBe(idle.pid);
    await supervisor({ mode: "leave", id: racingId, hostId: racing.result.participant.id });

    // An admitted create request with its body still arriving also prevents release before it becomes a room.
    let writer!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { writer = controller; controller.enqueue(new TextEncoder().encode('{"url":')); } });
    const arrivingId = crypto.randomUUID();
    const input: RuntimeRequest = { url: "http://person.example/v1/meet", method: "POST", headers: [["content-type", "application/json"]],
      body: Buffer.from(JSON.stringify({ sessionId: "thread", requestId: arrivingId, name: "Arriving" })).toString("base64"), agentMeetingId: null,
      context: { sessions: ["thread"], activity: [{ meetingId: arrivingId, sessionId: "thread", threads: [] }] } };
    streamFinish = () => { writer.enqueue(new TextEncoder().encode(JSON.stringify(input).slice('{"url":'.length))); writer.close(); streamFinish = null; };
    const arriving = fetch("http://meet-runtime/runtime/request", { unix: socket, method: "POST", body: stream });
    await until(() => status(socket), value => value.requestsInFlight === 1);
    expect(await runtimeCall(socket, "/runtime/release", { instance: idle.instance }))
      .toEqual({ ok: true, value: { released: false, reason: "requests-in-flight" } });
    streamFinish();
    const arrived = await (await arriving).json();
    expect(arrived.ok).toBe(true);
    const arrivingHost = JSON.parse(Buffer.from(arrived.value.body, "base64").toString()).participant;
    expect((await status(socket)).rooms[0]!.id).toBe(arrivingId);
    await supervisor({ mode: "leave", id: arrivingId, hostId: arrivingHost.id });

    const rotated = await connectRuntime(data, `${runtimeRevision()}-changed`);
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) throw new Error(rotated.error);
    expect(rotated.value.pid).not.toBe(current.pid);
    expect(rotated.value.instance).not.toBe(current.instance);
    expect(rotated.value.rooms).toHaveLength(0);
    current = rotated.value;
    const db = new Database(join(data, "supervisor.sqlite3"));
    expect(db.query("SELECT id FROM meet_live_rooms").all()).toHaveLength(0);
    expect((db.query("SELECT ended_at FROM meet_records WHERE id=?").get(id) as any).ended_at).toBeNumber();
    const stoppedId = crypto.randomUUID();
    const stopped = await supervisor({ mode: "create", id: stoppedId });
    process.kill(stopped.workerPid, "SIGTERM");
    await until(async () => { try { process.kill(stopped.workerPid, 0); return false; } catch { return true; } }, exited => exited);
    expect((db.query("SELECT ended_at FROM meet_records WHERE id=?").get(stoppedId) as any).ended_at).toBeNumber();
    expect(db.query("SELECT id FROM meet_live_rooms").all()).toHaveLength(0);
    expect(db.query("SELECT pid FROM meet_runtime_owner").all()).toHaveLength(0);
    db.close();
  } finally {
    streamFinish?.();
    const available = await runtimeStatus(socket, 500);
    if (available.ok) {
      // Test cleanup, never a production rotation mechanism.
      process.kill(available.value.pid, "SIGKILL");
      await until(async () => { try { process.kill(available.value.pid, 0); return true; } catch { return false; } }, alive => !alive);
    }
    if (previousData === undefined) delete process.env.PI_REMOTE_DATA; else process.env.PI_REMOTE_DATA = previousData;
    if (previousConfig === undefined) delete process.env.PI_REMOTE_CONFIG; else process.env.PI_REMOTE_CONFIG = previousConfig;
    rmSync(data, { recursive: true, force: true });
  }
}, 20_000);

test("a reachable incompatible runtime is an explicit error and never replaced", async () => {
  const data = mkdtempSync(join(tmpdir(), "meet-incompatible-"));
  const socket = meetSocket(data);
  let calls = 0;
  const server = Bun.serve({ unix: socket, fetch() { calls++; return Response.json({ ok: true, value: { protocol: "another-protocol" } }); } });
  try {
    const result = await connectRuntime(data);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("incompatible protocol");
    expect(calls).toBe(1);
    expect((await fetch("http://meet-runtime/runtime/status", { unix: socket })).ok).toBe(true);
  } finally { await server.stop(true); rmSync(data, { recursive: true, force: true }); }
});
