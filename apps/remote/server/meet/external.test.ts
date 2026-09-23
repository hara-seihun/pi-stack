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
