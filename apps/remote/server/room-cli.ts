import { readFileSync } from "node:fs";
import { actionJournal, journalWarning, type ActionJournal, type ActionTicket } from "kenan-memory/journal";
import { roomMetadata } from "../shared/rooms";
import type { RoomSnapshot } from "../shared/rooms";

export const ROOM_HELP = `usage: pi-room OPERATION [ARGS] [--request-id UUID]

  list                           Rooms your person belongs to (including closed rooms)
  read ROOM_ID [--last N] [--work] Conversation; last 20 messages by default, 0 means all
  send ROOM_ID TEXT|-             Post as your person's Kenan; '-' reads stdin
  create TITLE                   Create a room containing only your person

--work includes transparent thinking, tools and context when reading.
Sends/creates generate a requestId unless supplied. Keep the returned requestId:
a lost acknowledgement may have executed; inspect first and reuse that ID, never a new one.
Acceptance means the room queued the message, not that Kenan's room turn completed.
No automatic retries. GET does not mark the room read or change its inbox visibility.
Identity comes from your local Unix socket UID, not USER, a person argument or a browser token.
PI_ROOM_URL selects the local router (default http://127.0.0.1:8788); it must be loopback.
Room membership is checked for every read and post. No filesystem access or sudo is needed.
`;

type Invocation = { operation: "list" | "read" | "send" | "create"; path: string; body?: Record<string, unknown>; requestId?: string; last: number; work: boolean };
export function parseRoomArgs(argv: string[], stdin = () => readFileSync(0, "utf8")): { ok: true; value: Invocation | null } | { ok: false; error: string } {
  if (!argv.length || argv.includes("--help") || argv[0] === "help") return { ok: true, value: null };
  const positional: string[] = []; let requestId: string | undefined; let last = 20; let work = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") { positional.push(...argv.slice(i + 1)); break; }
    if (arg === "--work") { work = true; continue; }
    if (arg === "--last") {
      const value = argv[++i];
      if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) return { ok: false, error: "--last requires a nonnegative integer" };
      last = Number(value); continue;
    }
    if (arg === "--request-id") { requestId = argv[++i]; if (!requestId || !/^[0-9a-f-]{36}$/i.test(requestId)) return { ok: false, error: "--request-id requires a UUID" }; continue; }
    if (arg.startsWith("--")) return { ok: false, error: `Unknown option ${arg}` };
    positional.push(arg);
  }
  const [operation, id, text] = positional;
  if (operation === "list" && positional.length === 1) return { ok: true, value: { operation, path: "/v1/agent-rooms", last, work } };
  if (operation === "create" && positional.length === 2 && id?.trim()) {
    requestId ??= crypto.randomUUID();
    return { ok: true, value: { operation, path: "/v1/agent-rooms", body: { requestId, title: id }, requestId, last, work } };
  }
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return { ok: false, error: "read/send require a room UUID; run pi-room list" };
  if (operation === "read" && positional.length === 2) return { ok: true, value: { operation, path: `/v1/agent-rooms/${id}`, last, work } };
  if (operation === "send" && positional.length === 3 && text) {
    requestId ??= crypto.randomUUID();
    return { ok: true, value: { operation, path: `/v1/agent-rooms/${id}/prompt`, body: { requestId, text: text === "-" ? stdin() : text }, requestId, last, work } };
  }
  return { ok: false, error: "Expected list, read ROOM_ID, send ROOM_ID TEXT|- or create TITLE" };
}

export type RoomFetch = (url: URL, options?: RequestInit) => Promise<Response>;
export async function runRoomCli(argv: string[], io = { out: (value: unknown) => console.log(JSON.stringify(value, null, 2)), error: (message: string) => console.error(message), help: (text: string) => console.log(text) }, request: RoomFetch = fetch, env: NodeJS.ProcessEnv = process.env, journal: Pick<ActionJournal, "begin" | "finish"> = actionJournal): Promise<number> {
  const parsed = parseRoomArgs(argv);
  if (!parsed.ok) { io.error(parsed.error); return 1; }
  const invocation = parsed.value;
  if (!invocation) { io.help(ROOM_HELP); return 0; }
  let endpoint: URL;
  try { endpoint = new URL(env.PI_ROOM_URL ?? `http://127.0.0.1:${env.PI_REMOTE_ROUTER_PORT ?? "8788"}`); }
  catch { io.error("Invalid local room router URL"); return 1; }
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.pathname !== "/" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    io.error("PI_ROOM_URL must be a local loopback HTTP origin without credentials"); return 1;
  }
  let ticket: ActionTicket | null = null; let dispatched = false;
  try {
    if (invocation.operation === "send") {
      const inspection = await request(new URL(invocation.path.replace(/\/prompt$/, ""), endpoint), { signal: AbortSignal.timeout(15_000) });
      const snapshot = await inspection.json();
      if (!inspection.ok) { io.out({ ...snapshot, requestId: invocation.requestId }); return 1; }
      const room = roomMetadata(snapshot.room);
      if (!room || typeof snapshot.person !== "string" || !room.members.some(member => member.user === snapshot.person)) {
        io.error("Room router did not report the authenticated person's membership; nothing was sent"); return 1;
      }
      ticket = journal.begin({ action: "room.post", actedFor: snapshot.person, recipients: room.members.map(member => member.user),
        roomId: room.id, summary: String(invocation.body!.text), externalId: `room:${room.id}:${invocation.requestId}` });
    }
    dispatched = Boolean(invocation.body);
    const response = await request(new URL(invocation.path, endpoint), { method: invocation.body ? "POST" : "GET",
      ...(invocation.body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(invocation.body) } : {}), signal: AbortSignal.timeout(15_000) });
    const value = await response.json();
    const acceptedRoom = roomMetadata(value.room);
    if (ticket && acceptedRoom) ticket.spec.recipients = acceptedRoom.members.map(member => member.user);
    const warning = journalWarning(journal.finish(ticket, response.ok ? "confirmed" : response.status >= 500 ? "unconfirmed" : "failed",
      value.replayed ? "Previously accepted room input acknowledged; no new input" : `Room owner HTTP ${response.status}; acceptance is not a completed room turn`));
    if (!response.ok) { io.out({ ...value, ...(invocation.requestId ? { requestId: invocation.requestId } : {}), ...(warning ? { journalWarning: warning } : {}) }); return 1; }
    if (invocation.operation === "read") {
      const { work, thinking, context, messages, ...snapshot } = value as RoomSnapshot;
      io.out({ ...snapshot, messages: invocation.last ? messages.slice(-invocation.last) : messages, ...(invocation.work ? { work, thinking, context } : {}) });
    } else if (invocation.operation === "list") io.out({ rooms: value.rooms });
    else io.out({ ...value, requestId: invocation.requestId, ...(warning ? { journalWarning: warning } : {}) });
    return 0;
  } catch (cause) {
    const warning = journalWarning(journal.finish(ticket, dispatched ? "unconfirmed" : "failed", "Room transport failed"));
    io.out({ error: dispatched ? "unconfirmed" : "transport", message: String(cause), ...(warning ? { journalWarning: warning } : {}),
      ...(invocation.requestId ? { requestId: invocation.requestId, guidance: dispatched ? "May have executed. Inspect the room; retry only with this requestId. Nothing was retried." : "Nothing was sent." } : {}) });
    return 1;
  }
}

if (import.meta.main) process.exitCode = await runRoomCli(process.argv.slice(2));
