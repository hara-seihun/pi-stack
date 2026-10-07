import { spawnSync } from "node:child_process";
import type { Rooms } from "./rooms";

/** Kernel socket identity, never a request header or a browser-session identity. */
export function roomPersonUids(users: string[], uidFor = (user: string): number | undefined => {
  const result = spawnSync("id", ["-u", user], { encoding: "utf8", timeout: 1000 });
  const value = result.stdout?.trim();
  return result.status === 0 && /^\d+$/.test(value) ? Number(value) : undefined;
}): ReadonlyMap<number, string> {
  const people = new Map<number, string>();
  for (const user of users) {
    const uid = uidFor(user);
    if (uid === undefined || uid === 0) continue;
    if (people.has(uid)) throw new Error("Room people must have distinct Unix identities");
    people.set(uid, user);
  }
  return people;
}

export async function handleAgentRooms(req: Request, peer: { uid: number } | undefined, people: ReadonlyMap<number, string>, rooms: Pick<Rooms, "handle"> | null): Promise<Response> {
  const actor = peer && people.get(peer.uid);
  if (!actor) return Response.json({ error: "Rooms require your own registered local Unix identity" }, { status: 403 });
  if (!rooms) return Response.json({ error: "Rooms are not enabled on this host" }, { status: 404 });
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/v1\/agent-rooms(?=\/|$)/, "/v1/rooms");
  const allowed = (req.method === "GET" && /^\/v1\/rooms(?:\/[0-9a-f-]{36})?$/.test(path))
    || (req.method === "POST" && /^\/v1\/rooms(?:\/[0-9a-f-]{36}\/prompt)?$/.test(path));
  if (!allowed) return Response.json({ error: "Unknown agent room operation" }, { status: 404 });
  let body: unknown;
  if (req.method === "POST") {
    try { body = await req.json(); } catch { return Response.json({ error: "JSON required" }, { status: 400 }); }
    // Agent-created rooms are private to this person. Inviting others stays with the human room UI.
    if (path === "/v1/rooms") body = { ...(body as object), members: [] };
  }
  const historyQuery = new URLSearchParams();
  for (const name of ["before", "limit", "revision"]) for (const value of url.searchParams.getAll(name)) historyQuery.append(name, value);
  const response = await rooms.handle(new Request(`http://router${path}${historyQuery.size ? `?${historyQuery}` : ""}`, { method: req.method, signal: req.signal,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) }), actor, "agent");
  return Response.json({ ...await response.json(), person: actor }, { status: response.status });
}
