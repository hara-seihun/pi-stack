import type { Thread } from "pi-orchestrator/api";
import { roomFeed } from "./room-feed";
import { projectThreadActivity } from "./live-projection";
import { validateThreadObservation } from "../shared/state-validation";
import type { Room, RoomActivity, RoomSnapshot, RoomHistoryOptions, RoomPaging } from "../shared/rooms";
import { roomInput, roomMembers, roomMetadata, readRoomInput, readRoomPaging, readRoomHistoryOptions } from "../shared/rooms";

interface OwnedRoomThread { id: string; title: string; lifecycle: Thread["lifecycle"]; state: Thread["state"]; held?: boolean; metadata?: Record<string, unknown>; executionActivity?: Thread["executionActivity"] }
export interface RoomHistory { messages: unknown[]; paging: RoomPaging; live: string; questions?: RoomSnapshot["questions"]; thinking?: string; error?: string; execution?: RoomActivity }
export class RoomHistoryError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
interface RoomOwner {
  get(id: string): OwnedRoomThread | null;
  create(id: string, title: string, members: NonNullable<ReturnType<typeof roomMembers>>): Promise<void>;
  update(id: string, members: NonNullable<ReturnType<typeof roomMembers>>): Promise<void>;
  send(id: string, requestId: string, text: string): Promise<void>;
  history(id: string, options: RoomHistoryOptions): Promise<RoomHistory>;
  stop?(id: string): Promise<void>;
  answer?(id: string, questionId: string, sender: NonNullable<ReturnType<typeof roomMembers>>[number], body: any): Promise<void>;
  notify(id: string, receiptId: string, title: string, body: string, time: number): void | Promise<void>;
  subscribe?(listener: (id: string) => void): () => void;
}
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);
const fail = (error: string, status = 400) => Response.json({ error }, { status });

export function publicRoomSnapshot(thread: OwnedRoomThread, source: RoomHistory): RoomSnapshot {
  if (!readRoomPaging(source.paging) || source.messages.length !== source.paging.end - source.paging.start) throw new RoomHistoryError(503, "Room owner returned an invalid history page");
  const metadata = roomMetadata(thread.metadata?.room)!;
  const execution = projectThreadActivity(thread);
  const error = source.error ?? execution.executionError;
  let activity: RoomActivity;
  try {
    validateThreadObservation({ state: thread.state, ...execution });
    activity = { ...execution, held: thread.held ?? false,
      ...(thread.metadata?.agentWait ? { waitingOnAgents: thread.metadata.agentWait as Thread["waitingOnAgents"] } : {}),
      ...(error ? { error } : {}) };
    if (execution.activity === "status_error") {
      const detail = execution.activityDetail ?? error ?? "Room owner did not report an execution phase";
      activity.activityDetail = detail;
      activity.error = error ?? detail;
    }
  } catch {
    activity = { activity: "status_error", activityDetail: "Room owner did not report a supported execution phase", activeTools: execution.activeTools ?? [],
      held: thread.held ?? false, error: error ?? "Room owner did not report a supported execution phase" };
  }
  const room: Room = { ...metadata, title: thread.title, state: thread.state, ...activity };
  const messages: RoomSnapshot["messages"] = [];
  const work: NonNullable<RoomSnapshot["work"]> = [];
  for (const [index, value] of source.messages.entries()) {
    if (!value || typeof value !== "object") continue;
    const message = value as Record<string, any>;
    const entryId = typeof message.identity?.id === "string" ? message.identity.id : `entry:${source.paging.start + index}`;
    if (message.role === "assistant" && Array.isArray(message.content)) for (const [blockIndex, block] of message.content.entries()) {
      if (block?.type === "thinking") work.push({ id: `${entryId}:${blockIndex}`, kind: "thinking", text: String(block.thinking ?? "") });
      if (block?.type === "toolCall") work.push({ id: `${entryId}:${blockIndex}`, kind: "toolCall", name: block.name, text: JSON.stringify(block.arguments, null, 2) ?? "" });
    }
    if (message.role === "toolResult") work.push({ id: entryId, kind: "toolResult", name: message.toolName, text: typeof message.content === "string" ? message.content : JSON.stringify(message.content, null, 2) ?? "" });
    if (message.role !== "user" && message.role !== "assistant") {
      if (message.role !== "toolResult") work.push({ id: entryId, kind: typeof (message.content?.customType ?? message.content?.type) === "string" ? (message.content.customType ?? message.content.type).replaceAll("_", " ") : "notice", text: JSON.stringify(message, null, 2) });
      continue;
    }
    const text = typeof message.content === "string" ? message.content : Array.isArray(message.content)
      ? message.content.filter((block: any) => block?.type === "text" && typeof block.text === "string").map((block: any) => block.text).join("\n") : "";
    if (!text) continue;
    const input = message.role === "user" ? readRoomInput(text) : null;
    if (message.role === "user" && !input) { work.push({ id: entryId, kind: "notice", text }); continue; }
    const time = Number(message.timestamp) || 0;
    messages.push({ id: entryId, time, sender: input?.sender ?? { user: "assistant", displayName: "Kenan" }, text: input?.text ?? text });
  }
  return { room, state: thread.state, ...activity, messages, paging: source.paging, live: source.live, questions: source.questions ?? [], work, thinking: source.thinking ?? "",
    notificationId: thread.state === "idle" && source.paging.end === source.paging.total ? messages.filter(message => message.sender.user === "assistant").at(-1)?.id ?? null : null };
}

/** Invoked only after the supervisor verifies the router's person caller. */
export async function handleRoomOwner(req: Request, owner: RoomOwner): Promise<Response> {
  const url = new URL(req.url);
  const match = /^\/v1\/room-owner\/([0-9a-f-]{36})(?:\/(changes|members|prompt|notify|abort|questions\/[^/]+\/answer))?$/.exec(url.pathname);
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
    await owner.notify(id, body.receiptId, body.title.slice(0, 120), body.body.slice(0, 1000), body.time);
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
  if (action === "changes" && req.method === "GET") {
    if (!owner.subscribe) return fail("Room change subscription unavailable", 503);
    return roomFeed(req.signal, send => {
      const authorized = () => roomMetadata(owner.get(id)?.metadata?.room)?.members.some(member => member.user === actor) === true;
      const unsubscribe = owner.subscribe!(changed => {
        if (changed === id) send({ changed: true, authorized: authorized() });
      });
      send({ changed: true, authorized: authorized() });
      return unsubscribe;
    });
  }
  if (!action && req.method === "GET") {
    const parsed = readRoomHistoryOptions(url.searchParams);
    if (!parsed.ok) return fail(parsed.error);
    let inspected: { ok: true; history: RoomHistory } | { ok: false; cause: unknown };
    try { inspected = { ok: true, history: await owner.history(id, parsed.value) }; }
    catch (cause) { inspected = { ok: false, cause }; }
    const current = owner.get(id);
    const audience = roomMetadata(current?.metadata?.room);
    if (!current || audience?.id !== id) return fail("Room not found", 404);
    if (!audience.members.some(member => member.user === actor)) return fail("Room membership required", 403);
    if (req.signal.aborted) return fail("Room request ended", 423);
    if (!inspected.ok) return inspected.cause instanceof RoomHistoryError ? fail(inspected.cause.message, inspected.cause.status) : fail("Room history retrieval failed", 503);
    try { return Response.json(publicRoomSnapshot(current, inspected.history)); }
    catch (cause) { return cause instanceof RoomHistoryError ? fail(cause.message, cause.status) : fail("Room history projection failed", 503); }
  }
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
    const member = metadata.members.find(member => member.user === actor)!;
    const sender = body.senderKind === "agent" ? { ...member, displayName: `${member.displayName}'s Kenan`, agent: true as const } : member;
    await owner.send(id, body.requestId, roomInput(sender, body.text));
    return Response.json({ accepted: true }, { status: 202 });
  }
  return fail("Unknown room operation", 405);
}
