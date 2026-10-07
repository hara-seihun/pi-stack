import { Database } from "bun:sqlite";
import { join } from "node:path";
import { applyLocalConfig } from "../../config";

applyLocalConfig();
const { MeetGateway } = await import("../gateway");
const { meetData } = await import("../runtime");
const input = JSON.parse(process.argv[2]!);
const db = new Database(join(meetData(), "supervisor.sqlite3"), { create: true, strict: true });
db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
const connected = await MeetGateway.connect(db, {
  sessionExists: id => id === "thread",
  threadActivity: () => [{ id: "thread", name: input.mode, state: "idle", held: false, activity: "idle", tools: [], output: "", events: [] }],
});
if (!connected.ok) { console.error(connected.error); process.exit(1); }
const gateway = connected.value;
const request = async (path: string, method = "GET", body?: unknown) => {
  const result = await gateway.handle(new Request(`http://person.example/v1/meet${path}`, { method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) }));
  if (!result || !result.ok) throw new Error(`Gateway fixture failed: ${result?.status} ${await result?.text()}`);
  return result.json();
};
let result: unknown;
if (input.mode === "seed") {
  const host = await request("", "POST", { requestId: input.id, sessionId: "thread", name: "Host" });
  const guest = await request(`/${input.id}/join`, "POST", { name: "Guest" });
  const hostQuery = `?participant=${host.participant.id}`;
  const signalBody = { to: guest.participant.id, signal: { description: { type: "offer", sdp: "v=0\r\n" } }, requestId: input.signalId };
  await request(`/${input.id}/signal${hostQuery}`, "POST", signalBody);
  await request(`/${input.id}/signal${hostQuery}`, "POST", signalBody);
  await request(`/${input.id}/voice${hostQuery}`, "POST", { muted: false });
  await request(`/${input.id}/voice${hostQuery}`, "POST", { muted: true });
  await request(`/${input.id}/voice${hostQuery}`, "POST", { muted: false });
  await request(`/${input.id}/transcript/assistant${hostQuery}`, "POST", { id: "voice-turn", text: "Meetings survive the front door.", final: true, startedAt: Date.now() });
  result = { host, guest, signalBody };
} else if (input.mode === "inspect") {
  const room = await request(`/${input.id}`);
  const poll = await request(`/${input.id}/poll?participant=${input.guestId}`);
  await request(`/${input.id}/signal?participant=${input.hostId}`, "POST", input.signalBody);
  const repeated = await request(`/${input.id}/poll?participant=${input.guestId}`);
  const duplicateCreate = await request("", "POST", { requestId: input.id, sessionId: "thread", name: "Host" });
  const mismatch = await gateway.handle(new Request(`http://person.example/v1/meet/${input.id}/signal?participant=${input.hostId}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...input.signalBody, signal: { candidate: { candidate: "different" } } }) }));
  result = { room, poll, repeated, duplicateCreate, mismatchStatus: mismatch!.status, live: gateway.isLive(input.id), meetings: gateway.transcripts.meetings(), turns: gateway.transcripts.read(input.id) };
} else if (input.mode === "leave") {
  await request(`/${input.id}/leave?participant=${input.hostId}`, "POST");
  result = { live: gateway.isLive(input.id), meetings: gateway.transcripts.meetings() };
} else if (input.mode === "create") {
  result = await request("", "POST", { requestId: input.id, sessionId: "thread", name: "Host" });
} else throw new Error("Unknown fixture mode");
console.log(JSON.stringify({ supervisorPid: process.pid, workerPid: gateway.runtime.pid, instance: gateway.runtime.instance, result }));
db.close();
process.exit(0);
