import type { Room, RoomSnapshot } from "../shared/rooms";
import { roomInput, roomMembers, roomMetadata, readRoomInput } from "../shared/rooms";

interface OwnedRoomThread { id: string; title: string; state: "idle" | "running"; metadata?: Record<string, unknown> }
interface RoomOwner {
  get(id: string): OwnedRoomThread | null;
  create(id: string, title: string, members: NonNullable<ReturnType<typeof roomMembers>>): Promise<void>;
  update(id: string, members: NonNullable<ReturnType<typeof roomMembers>>): Promise<void>;
  send(id: string, requestId: string, text: string): Promise<void>;
  history(id: string): Promise<{ messages: unknown[]; live: string; questions?: RoomSnapshot["questions"] }>;
  stop?(id: string): Promise<void>;
  answer?(id: string, questionId: string, sender: NonNullable<ReturnType<typeof roomMembers>>[number], body: any): Promise<void>;
  notify(id: string, receiptId: string, title: string, body: string, time: number): void;
}
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);
const fail = (error: string, status = 400) => Response.json({ error }, { status });

export function publicRoomSnapshot(thread: OwnedRoomThread, source: { messages: unknown[]; live: string; questions?: RoomSnapshot["questions"] }): RoomSnapshot {
  const metadata = roomMetadata(thread.metadata?.room)!;
  const room: Room = { ...metadata, title: thread.title };
  const messages: RoomSnapshot["messages"] = [];
  for (const value of source.messages) {
    if (!value || typeof value !== "object") continue;
    const message = value as Record<string, any>;
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = typeof message.content === "string" ? message.content : Array.isArray(message.content)
      ? message.content.filter((block: any) => block?.type === "text" && typeof block.text === "string").map((block: any) => block.text).join("\n") : "";
    if (!text) continue;
    const input = message.role === "user" ? readRoomInput(text) : null;
    // Agent inputs, private custom messages and compaction summaries aren't room utterances.
    if (message.role === "user" && !input) continue;
    const time = Number(message.timestamp) || 0;
    const id = typeof message.identity?.id === "string" ? message.identity.id : `${message.role}:${time}:${messages.length}`;
    messages.push({ id, time, sender: input?.sender ?? { user: "assistant", displayName: "Kenan" }, text: input?.text ?? text });
  }
  return { room, state: thread.state, messages, live: source.live, questions: source.questions ?? [],
    notificationId: thread.state === "idle" ? messages.filter(message => message.sender.user === "assistant").at(-1)?.id ?? null : null };
}

/** Invoked only after the supervisor verifies the router's person caller. */
export async function handleRoomOwner(req: Request, owner: RoomOwner): Promise<Response> {
  const url = new URL(req.url);
  const match = /^\/v1\/room-owner\/([0-9a-f-]{36})(?:\/(members|prompt|notify|abort|questions\/[^/]+\/answer))?$/.exec(url.pathname);
  if (!match) return fail("Unknown room operation", 404);
  const id = match[1]!, action = match[2];
  const actor = req.headers.get("x-pi-remote-user") ?? "";
  const existing = owner.get(id);
  let body: any;
  if (req.method !== "GET") {
    try { body = await req.json(); } catch { return fail("JSON required"); }
  }
  if (action === "notify" && req.method === "POST") {
    if (typeof body?.receiptId !== "string" || body.receiptId.length > 300 || typeof body.title !== "string" || typeof body.body !== "string"
      || !Number.isFinite(body.time)) return fail("Invalid room notice");
    owner.notify(id, body.receiptId, body.title.slice(0, 120), body.body.slice(0, 1000), body.time);
    return Response.json({ ok: true });
  }
  if (!action && req.method === "POST") {
    const members = roomMembers(body?.members);
    if (!members?.some(member => member.user === actor) || typeof body.title !== "string" || !body.title.trim() || body.title.length > 120) return fail("Invalid room");
    if (existing && !roomMetadata(existing.metadata?.room)) return fail("A private thread cannot become a room", 409);
    if (!existing) await owner.create(id, body.title.trim(), members);
    return Response.json({ ok: true });
  }
  const metadata = roomMetadata(existing?.metadata?.room);
  if (!existing || !metadata || metadata.id !== id) return fail("Room not found", 404);
  if (!metadata.members.some(member => member.user === actor)) return fail("Room membership required", 403);
  if (!action && req.method === "GET") return Response.json(publicRoomSnapshot(existing, await owner.history(id)));
  if (action === "members" && req.method === "POST") {
    const members = roomMembers(body?.members);
    if (!members || metadata.members.some(old => !members.some(member => member.user === old.user))) return fail("Only adding room members is supported");
    if (existing.state !== "idle") return fail("Wait for Kenan's turn to finish before adding someone", 409);
    await owner.update(id, members);
    return Response.json({ ok: true });
  }
  if (action === "abort" && req.method === "POST" && owner.stop) {
    await owner.stop(id); return Response.json({ ok: true });
  }
  if (action?.startsWith("questions/") && req.method === "POST" && owner.answer) {
    await owner.answer(id, action.split("/")[1]!, metadata.members.find(member => member.user === actor)!, body);
    return Response.json({ accepted: true });
  }
  if (action === "prompt" && req.method === "POST") {
    if (!uuid(body?.requestId) || typeof body.text !== "string" || !body.text.trim() || body.text.length > 100_000) return fail("A requestId and message are required");
    const sender = metadata.members.find(member => member.user === actor)!;
    await owner.send(id, body.requestId, roomInput(sender, body.text));
    return Response.json({ accepted: true }, { status: 202 });
  }
  return fail("Unknown room operation", 405);
}
