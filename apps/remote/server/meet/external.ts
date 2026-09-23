import { createHash } from "node:crypto";
import { API_CORS_HEADERS } from "../cors";
import type { MeetServer } from "./server";

function identity(namespace: string, eventKey: string, kind: string): string {
  const hash = createHash("sha256").update(JSON.stringify(["pistack-meet", namespace, eventKey, kind])).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { ...API_CORS_HEADERS, "cache-control": "no-store" } });

export async function externalMeetingRequest(req: Request, meet: MeetServer,
  ensureThread: (sessionId: string, meetingId: string, name: string) => void | Promise<void>): Promise<Response | null> {
  const url = new URL(req.url);
  if (!/^\/v1\/meet\/external(?:\/|$)/.test(url.pathname)) return null;
  try {
    const stop = /^\/v1\/meet\/external\/([0-9a-f-]{36})\/stop$/.exec(url.pathname);
    if (stop && req.method === "POST") {
      if (!meet.transcripts.has(stop[1]!)) return json({ error: "Meeting not found" }, 404);
      meet.stopExternal(stop[1]!);
      return json({ stopped: true, meetingId: stop[1] });
    }
    const start = req.method === "POST" && url.pathname === "/v1/meet/external";
    const transcript = req.method === "GET" && url.pathname === "/v1/meet/external/transcript";
    if (!start && !transcript) return json({ error: "Unknown external meeting operation" }, 404);
    const body = start ? await req.json() : Object.fromEntries(url.searchParams);
    if (typeof body.namespace !== "string" || !/^[a-z][a-z0-9._-]{0,79}$/.test(body.namespace)
      || typeof body.eventKey !== "string" || !body.eventKey.trim() || body.eventKey.length > 2000) return json({ error: "namespace and eventKey are required" }, 400);
    const meetingId = identity(body.namespace, body.eventKey, "room");
    const sessionId = identity(body.namespace, body.eventKey, "thread");
    if (transcript) {
      const target = new URL(`/v1/meet/${meetingId}/transcript`, url);
      if (url.searchParams.get("format") === "text") target.searchParams.set("format", "text");
      const response = (await meet.handle(new Request(target)))!;
      response.headers.set("x-pi-meeting-id", meetingId);
      response.headers.set("x-pi-session-id", sessionId);
      return response;
    }
    await ensureThread(sessionId, meetingId, typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 120) : `${body.namespace} meeting`);
    return json(meet.openExternal(meetingId, sessionId, `${url.origin}/v1/meet/${meetingId}`));
  } catch (cause) {
    return json({ error: cause instanceof Error ? cause.message : String(cause) }, 400);
  }
}
