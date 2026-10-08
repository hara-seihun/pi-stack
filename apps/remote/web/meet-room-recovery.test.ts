import { expect, test } from "bun:test";
import type { MeetJoined } from "../server/meet/protocol";
import { ExternalMeetRoom } from "./src/meet/external-room";
import type { MeetRequest } from "./src/meet/transport";

const participant = { id: "external-host", name: "Mixed meeting audio", host: true };
const joined: MeetJoined = { participant,
  room: { id: "room", sessionId: "thread", apiUrl: "/v1/meet/room", participants: [participant],
    browser: null, threads: [], voiceMuted: false, voiceRevision: 3,
    voiceWake: null, platformTranscript: true, transcriptFlushRevision: 0 },
};
const tick = () => new Promise<void>(resolve => queueMicrotask(resolve));

for (const failure of ["503", "network"] as const) test(`${failure} during external poll retains identity and confirmed Voice state`, async () => {
  const paths: string[] = [];
  let polls = 0;
  const failures: string[] = [];
  const request: MeetRequest = async path => {
    paths.push(path);
    polls++;
    if (polls === 2) {
      if (failure === "network") throw new TypeError("Failed to fetch");
      return new Response("router restarting", { status: 503 });
    }
    return Response.json({ ...joined.room, voiceMuted: true, voiceRevision: 2 });
  };
  const room = new ExternalMeetRoom(joined, () => {}, message => failures.push(message), request);
  try {
    await room.poll();
    await room.poll();
    expect(paths).toEqual(Array(3).fill("/v1/meet/room/poll?participant=external-host"));
    expect(room.joined).toBe(joined);
    expect(room.snapshot.voiceRevision).toBe(3);
    expect(room.snapshot.voiceMuted).toBe(false);
    expect(failures).toEqual([]);
  } finally { room.close(); }
});

for (const terminal of ["404", "permission", "invalid JSON", "invalid identity"] as const) test(`${terminal} ends external polling without transport retry`, async () => {
  let calls = 0;
  const failures: string[] = [];
  const room = new ExternalMeetRoom(joined, () => {}, message => failures.push(message), async () => {
    calls++;
    if (terminal === "404") return Response.json({ error: "Meeting missing" }, { status: 404 });
    if (terminal === "permission") return Response.json({ error: "Not allowed" }, { status: 403 });
    if (terminal === "invalid JSON") return new Response("invalid json");
    return Response.json({ ...joined.room, participants: [] });
  });
  try {
    await room.poll();
    await room.poll();
    expect(failures).toHaveLength(1);
    expect(calls).toBe(1);
  } finally { room.close(); }
});

test("explicit suspend cancels external transport recovery without resurrecting polling", async () => {
  let calls = 0;
  const failures: string[] = [];
  const room = new ExternalMeetRoom(joined, () => {}, message => failures.push(message), async () => {
    calls++;
    return new Response("deploying", { status: 503 });
  });
  const recovering = room.poll();
  await tick();
  room.close();
  await recovering;
  await room.poll();
  expect(failures).toEqual([]);
  expect(calls).toBe(1);
});

test("external poll recovery stays bounded even when the relay ignores cancellation", async () => {
  const timers = new Map<number, { after: number; run(): void }>();
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  let serial = 0, now = 0;
  globalThis.setTimeout = ((run: () => void, after: number) => {
    const id = ++serial; timers.set(id, { after: now + after, run }); return id;
  }) as any;
  globalThis.clearTimeout = ((id: number) => { timers.delete(id); }) as any;
  const failures: string[] = [];
  let calls = 0;
  const room = new ExternalMeetRoom(joined, () => {}, message => failures.push(message), async () => {
    calls++;
    return new Promise<Response>(() => {});
  });
  try {
    const result = room.poll();
    await tick();
    while (timers.size) {
      const [id, timer] = [...timers].sort((a, b) => a[1].after - b[1].after)[0]!;
      timers.delete(id); now = timer.after; timer.run();
      for (let i = 0; i < 10; i++) await tick();
    }
    await result;
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("did not recover within 20 seconds");
    expect(now).toBe(20_000);
    expect(calls).toBe(4);
  } finally { room.close(); globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear; }
});
