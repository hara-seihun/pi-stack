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
const open = () => gateway.openExternal(input.id, "thread", `http://person.example/v1/meet/${input.id}`, true);
let result: unknown;
if (input.mode === "seed") {
  const host = await open();
  const camera = await request(`/${input.id}/join`, "POST", { name: "Sara" });
  const hostQuery = `?participant=${host.participant.id}`;
  for (const muted of [false, true, false]) await request(`/${input.id}/voice${hostQuery}`, "POST", { muted });
  await request(`/${input.id}/transcript/assistant${hostQuery}`, "POST", { id: "voice-turn", text: "Meetings survive the front door.", final: true, startedAt: 1 });
  await request(`/${input.id}/transcript/turn${hostQuery}`, "POST", { id: "platform-turn", speakerId: "recall:42", speaker: "Sara", text: "Kenan, keep the browser open.", startedAt: 2 });
  const uploaded = await gateway.handle(new Request(`http://person.example/v1/meet/${input.id}/frame?participant=${camera.participant.id}`, {
    method: "PUT", headers: { "content-type": "image/jpeg" }, body: new Uint8Array([255, 216, 255, 217]),
  }));
  if (!uploaded?.ok) throw new Error("Camera upload failed");
  result = { host, camera };
} else if (input.mode === "inspect") {
  const room = await request(`/${input.id}`);
  const poll = await request(`/${input.id}/poll?participant=${input.hostId}`);
  const duplicateOpen = await open();
  result = { room, poll, duplicateOpen, capture: await gateway.captureDelegation(input.id), live: gateway.isLive(input.id),
    meetings: gateway.transcripts.meetings(), turns: gateway.transcripts.read(input.id) };
} else if (input.mode === "leave") {
  await gateway.stopExternal(input.id);
  result = { live: gateway.isLive(input.id), meetings: gateway.transcripts.meetings() };
} else if (input.mode === "create") {
  result = await open();
} else throw new Error("Unknown fixture mode");
console.log(JSON.stringify({ supervisorPid: process.pid, workerPid: gateway.runtime.pid, instance: gateway.runtime.instance, result }));
db.close();
process.exit(0);
