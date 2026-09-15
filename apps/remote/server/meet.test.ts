import { describe, expect, test } from "bun:test";
import { MeetServer } from "./meet/server";
import type { MeetBrowser } from "./meet/browser";

const request = (path: string, method = "GET", body?: unknown) => new Request(`http://127.0.0.1:18790/v1/meet${path}`, {
  method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
});

async function start(server: MeetServer) {
  const response = await server.handle(request("", "POST", { requestId: crypto.randomUUID(), sessionId: "thread", name: "Host" }));
  expect(response!.status).toBe(201);
  return response!.json();
}

describe("PiStack Meet", () => {
  test("a lost creation response does not create a second room or host", async () => {
    const server = new MeetServer(() => true);
    try {
      const body = { requestId: crypto.randomUUID(), sessionId: "thread", name: "Host" };
      const first = await (await server.handle(request("", "POST", body)))!.json();
      const second = await (await server.handle(request("", "POST", body)))!.json();
      expect(second).toEqual(first);
      expect((await (await server.handle(request("")))!.json()).rooms).toHaveLength(1);
      expect((await server.handle(request("", "POST", { ...body, sessionId: "another" })))!.status).toBe(409);
      await server.handle(request(`/${first.room.id}/leave?participant=${first.participant.id}`, "POST"));
      expect((await server.handle(request("", "POST", body)))!.status).toBe(409);
    } finally { await server.close(); }
  });
  test("signaling is replayed until acknowledged, belongs to a recipient, and dies with the host", async () => {
    const server = new MeetServer((id) => id === "thread");
    try {
      const host = await start(server);
      const root = `/${host.room.id}`;
      const guest = await (await server.handle(request(`${root}/join`, "POST", { name: "Guest" })))!.json();
      const hostQuery = `?participant=${host.participant.id}`;
      const guestQuery = `?participant=${guest.participant.id}`;
      const signal = { description: { type: "offer", sdp: "v=0\r\n" }, streams: { microphone: "camera" } };
      expect((await server.handle(request(`${root}/signal${hostQuery}`, "POST", { to: guest.participant.id, signal })))!.status).toBe(200);
      const first = await (await server.handle(request(`${root}/poll${guestQuery}`)))!.json();
      const again = await (await server.handle(request(`${root}/poll${guestQuery}`)))!.json();
      expect(first.messages).toEqual(again.messages);
      expect(first.messages[0].signal).toEqual(signal);
      const hostPoll = await (await server.handle(request(`${root}/poll${hostQuery}`)))!.json();
      expect(hostPoll.messages).toEqual([]);
      const acknowledged = await (await server.handle(request(`${root}/poll${guestQuery}&after=${first.messages[0].seq}`)))!.json();
      expect(acknowledged.messages).toEqual([]);
      expect((await server.handle(request(`${root}/signal${guestQuery}`, "POST", { to: host.participant.id, signal: { streams: { fake: "pi-camera" } } })))!.status).toBe(403);
      expect((await server.handle(request(`${root}/leave${hostQuery}`, "POST")))!.status).toBe(200);
      expect((await server.handle(request(`${root}/poll${guestQuery}`)))!.status).toBe(404);
    } finally { await server.close(); }
  });

  test("ordinary peer-to-peer rooms retain their twelve-person limit", async () => {
    const server = new MeetServer(() => true);
    try {
      const host = await start(server);
      const root = `/${host.room.id}`;
      for (let i = 0; i < 11; i++) {
        expect((await server.handle(request(`${root}/join`, "POST", { name: `Guest ${i}` })))!.status).toBe(201);
      }
      const rejected = await server.handle(request(`${root}/join`, "POST", { name: "Overflow", external: true }));
      expect(rejected!.status).toBe(409);
      expect((await rejected!.json()).error).toContain("maximum 12 people");
      expect((await (await server.handle(request(root)))!.json()).participants).toHaveLength(12);
    } finally { await server.close(); }
  });

  test("leaving during browser startup closes the candidate instead of leaking it", async () => {
    let ready!: (value: { ok: true; value: MeetBrowser }) => void;
    let closed = 0;
    const browser = { close: async () => { closed++; } } as unknown as MeetBrowser;
    const server = new MeetServer(() => true, () => new Promise((resolve) => { ready = resolve; }));
    try {
      const host = await start(server);
      const root = `/${host.room.id}`;
      const query = `?participant=${host.participant.id}`;
      const opening = server.handle(request(`${root}/browser${query}`, "POST", {}));
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      await server.handle(request(`${root}/leave${query}`, "POST"));
      ready({ ok: true, value: browser });
      expect((await opening)!.status).toBe(503);
      expect(closed).toBe(1);
    } finally { await server.close(); }
  });

  test("camera frames are per-person and removed on departure", async () => {
    const server = new MeetServer(() => true);
    try {
      const host = await start(server);
      const root = `/${host.room.id}`;
      const guest = await (await server.handle(request(`${root}/join`, "POST", { name: "Guest" })))!.json();
      const bytes = new Uint8Array([255, 216, 255, 217]);
      const response = await server.handle(new Request(`http://127.0.0.1/v1/meet${root}/frame?participant=${guest.participant.id}`, { method: "PUT", headers: { "content-type": "image/jpeg" }, body: bytes }));
      expect(response!.status).toBe(200);
      expect((await server.handle(request(`${root}/participants/${host.participant.id}/frame`)))!.status).toBe(404);
      expect((await server.handle(request(`${root}/participants/${guest.participant.id}/frame`)))!.status).toBe(200);
      await server.handle(request(`${root}/leave?participant=${guest.participant.id}`, "POST"));
      expect((await server.handle(request(`${root}/participants/${guest.participant.id}/frame`)))!.status).toBe(404);
      expect((await server.handle(request(root)))!.status).toBe(200);
    } finally { await server.close(); }
  });
});
