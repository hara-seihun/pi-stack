import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { externalMeetingRequest } from "./external";
import { MeetServer } from "./server";

const request = (path: string, body?: unknown) => new Request(`http://localhost/v1/meet${path}`, body === undefined ? {} : {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

test("external reconnection keeps the meeting thread and transcript, including after supervisor replacement", async () => {
  const db = new Database(":memory:");
  let server = new MeetServer(() => true, undefined, db);
  const threads = new Set<string>();
  const ensureThread = (id: string) => { threads.add(id); };
  const body = { namespace: "converge", eventKey: "calendar-event" };
  try {
    const first = await (await externalMeetingRequest(request("/external", body), server, ensureThread))!.json();
    const again = await (await externalMeetingRequest(request("/external", body), server, ensureThread))!.json();
    expect(again).toEqual(first);
    expect(first.participant.name).toBe("Mixed meeting audio");
    server.transcripts.assistant("spoken", first.room.id, "Hello.", true, 1);
    await externalMeetingRequest(request(`/external/${first.room.id}/stop`, {}), server, ensureThread);
    await server.close();
    server = new MeetServer(() => true, undefined, db);
    const exported = await externalMeetingRequest(request("/external/transcript?namespace=converge&eventKey=calendar-event"), server, ensureThread);
    expect((await exported!.json()).turns[0].text).toBe("Hello.");
    expect(exported!.headers.get("x-pi-session-id")).toBe(first.room.sessionId);
    const reopened = await (await externalMeetingRequest(request("/external", body), server, ensureThread))!.json();
    expect(reopened.room.id).toBe(first.room.id);
    expect(reopened.room.sessionId).toBe(first.room.sessionId);
    expect(threads.size).toBe(1);
  } finally { await server.close(); db.close(); }
});

test("external rooms admit 32 camera sources plus their host and preserve state on reconnect", async () => {
  const server = new MeetServer(() => true);
  const body = { namespace: "converge", eventKey: "camera-capacity" };
  const open = async () => (await externalMeetingRequest(request("/external", body), server, () => {}))!.json();
  try {
    const host = await open();
    const root = `/${host.room.id}`;
    await server.handle(request(`${root}/voice?participant=${host.participant.id}`, { muted: false }));
    await server.handle(request(`${root}/voice?participant=${host.participant.id}`, { muted: true }));
    const cameras: string[] = [];
    for (let i = 0; i < 32; i++) {
      const joined = await server.handle(request(`${root}/join`, { name: `Camera ${i}` }));
      expect(joined!.status).toBe(201);
      const { participant } = await joined!.json();
      cameras.push(participant.id);
      const frame = new Uint8Array([255, 216, i, 255, 217]);
      expect((await server.handle(new Request(`http://localhost/v1/meet${root}/frame?participant=${participant.id}`, {
        method: "PUT", headers: { "content-type": "image/jpeg" }, body: frame,
      })))!.status).toBe(200);
      const saved = await server.handle(request(`${root}/participants/${participant.id}/frame`));
      expect(new Uint8Array(await saved!.arrayBuffer())).toEqual(frame);
    }
    const rejected = await server.handle(request(`${root}/join`, { name: "Overflow" }));
    expect(rejected!.status).toBe(409);
    expect((await rejected!.json()).error).toContain("32 camera sources");
    const resumed = await open();
    expect(resumed.participant).toEqual(host.participant);
    expect(resumed.room.participants).toHaveLength(33);
    expect(resumed.room.voiceMuted).toBe(true);
    expect(resumed.room.voiceRevision).toBe(2);
    expect(server.captureDelegation(host.room.id).images).toHaveLength(32);
    await server.handle(new Request(`http://localhost/v1/meet${root}/leave?participant=${cameras[0]}`, { method: "POST" }));
    expect((await server.handle(request(`${root}/participants/${cameras[0]}/frame`)))!.status).toBe(404);
    expect((await server.handle(request(`${root}/join`, { name: "Replacement" })))!.status).toBe(201);
    expect((await open()).room.voiceRevision).toBe(2);
  } finally { await server.close(); }
});

test("a host flush acknowledgement settles all covered delegation requests", async () => {
  const server = new MeetServer(() => true);
  try {
    const host = server.openExternal(crypto.randomUUID(), "thread", "http://localhost/v1/meet");
    const first = server.flushTranscript(host.room.id);
    const second = server.flushTranscript(host.room.id);
    const poll = await (await server.handle(request(`/${host.room.id}/poll?participant=${host.participant.id}`)))!.json();
    expect(poll.transcriptFlushRevision).toBe(2);
    await server.handle(request(`/${host.room.id}/transcript/flushed?participant=${host.participant.id}`, { revision: 2 }));
    await Promise.all([first, second]);
    const failed = server.flushTranscript(host.room.id).then(() => null, (error: Error) => error);
    await server.handle(request(`/${host.room.id}/transcript/flushed?participant=${host.participant.id}`, { revision: 3, error: "capture failed" }));
    expect((await failed)?.message).toContain("capture failed");
  } finally { await server.close(); }
});
