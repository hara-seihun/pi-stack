import { expect, test } from "bun:test";
import { MeetingStart } from "./src/meet/start";

test("native meeting creation leaves model and speed to the shared server mode, retaining identity on retry", async () => {
  const calls: Array<{ path: string; body: any }> = [];
  let lost = true;
  const start = new MeetingStart("person", async <T>(path: string, owner: string, init?: RequestInit): Promise<T> => {
    expect(owner).toBe("person");
    const body = JSON.parse(String(init?.body));
    calls.push({ path, body });
    if (path === "/v1/sessions") {
      if (lost) { lost = false; throw new Error("creation response lost"); }
      return { session: { id: body.sessionId } } as T;
    }
    return { room: { id: body.requestId, sessionId: body.sessionId }, participant: { id: "host" } } as T;
  });
  await expect(start.start("Host")).rejects.toThrow("creation response lost");
  const joined = await start.start("Host");
  expect(calls).toHaveLength(3);
  expect(calls[1]).toEqual(calls[0]);
  expect(calls[0]!.body).toEqual({ requestId: expect.any(String), sessionId: joined.room.sessionId, meetingId: joined.room.id });
  expect(calls[2]!.body).toEqual({ requestId: joined.room.id, sessionId: joined.room.sessionId, name: "Host" });
});
