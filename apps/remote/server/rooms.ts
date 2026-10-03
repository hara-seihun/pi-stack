import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Room, RoomMember, RoomSnapshot } from "../shared/rooms";

export const ROOM_CUSTODIAN = "pi-rooms";
interface StoredRoom extends Room { owner: string; creator: string; ready: number }
type Transport = (owner: string, actor: string, path: string, method: string, body?: unknown) => Promise<Response>;
const fail = (error: string, status = 400) => Response.json({ error }, { status });
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);

/** Host-owned directory and durable notification outbox. Conversation history stays with its thread owner. */
export class Rooms {
  private db: Database;
  private busy = false;
  private locks = new Map<string, Promise<unknown>>();
  constructor(path: string, private people: () => RoomMember[], private transport: Transport) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true });
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY,owner TEXT NOT NULL,creator TEXT NOT NULL,title TEXT NOT NULL,members TEXT NOT NULL,ready INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS deliveries(receipt TEXT NOT NULL,room TEXT NOT NULL,person TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,time INTEGER NOT NULL,delivered INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(receipt,person));`);
    const columns = this.db.query("PRAGMA table_info(rooms)").all() as { name: string }[];
    if (!columns.some(column => column.name === "creator")) {
      this.db.exec("ALTER TABLE rooms ADD COLUMN creator TEXT; UPDATE rooms SET creator=owner");
    }
  }
  close() { this.db.close(); }
  private rows(): StoredRoom[] {
    return (this.db.query("SELECT * FROM rooms ORDER BY rowid").all() as any[]).map(row => ({ ...row, members: JSON.parse(row.members) }));
  }
  private get(id: string): StoredRoom | undefined { return this.rows().find(room => room.id === id); }
  private visible(room: StoredRoom): Room { return { id: room.id, title: room.title, members: room.members }; }
  private roster(users: unknown, actor: string): RoomMember[] | null {
    if (!Array.isArray(users) || users.some(user => typeof user !== "string") || users.length > 63) return null;
    const ids = [...new Set(users)];
    if (!ids.includes(actor)) ids.unshift(actor);
    const people = this.people();
    const members = ids.map(user => people.find(person => person.user === user));
    return members.every(Boolean) ? members as RoomMember[] : null;
  }
  private notice(room: StoredRoom, receipt: string, body: string, exclude?: string, time = Date.now()) {
    for (const member of room.members) if (member.user !== exclude) this.db.query("INSERT OR IGNORE INTO deliveries(receipt,room,person,title,body,time) VALUES(?,?,?,?,?,?)")
      .run(receipt, room.id, member.user, room.title, body, time);
  }
  private async serialized<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.locks.get(id) ?? Promise.resolve()).catch(() => {}).then(operation);
    this.locks.set(id, next);
    try { return await next; } finally { if (this.locks.get(id) === next) this.locks.delete(id); }
  }
  async handle(req: Request, actor: string): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/v1/rooms" && req.method === "GET") {
      return Response.json({ rooms: this.rows().filter(room => room.ready && room.members.some(member => member.user === actor)).map(room => this.visible(room)), people: this.people() });
    }
    let body: any;
    if (req.method !== "GET") { try { body = await req.json(); } catch { return fail("JSON required"); } }
    if (url.pathname === "/v1/rooms" && req.method === "POST") {
      const members = this.roster(body?.members ?? [], actor);
      if (!uuid(body?.requestId) || !members || typeof body.title !== "string" || !body.title.trim() || body.title.length > 120) return fail("A requestId, title and known host members are required");
      const id = body.requestId;
      return this.serialized(id, async () => {
        let room = this.get(id);
        if (room && (room.creator !== actor || room.title !== body.title.trim() || JSON.stringify(room.members) !== JSON.stringify(members))) return fail("Room requestId already used", 409);
        if (!room) {
          this.db.query("INSERT INTO rooms(id,owner,creator,title,members) VALUES(?,?,?,?,?)").run(id, ROOM_CUSTODIAN, actor, body.title.trim(), JSON.stringify(members));
          room = this.get(id)!;
        }
        if (room.owner !== ROOM_CUSTODIAN) return fail("This room needs custody migration into the unprivileged room runtime", 503);
        if (!room.ready) {
          const created = await this.transport(room.owner, actor, `/v1/room-owner/${id}`, "POST", { title: room.title, members });
          if (!created.ok) return created;
          this.db.transaction(() => {
            this.db.query("UPDATE rooms SET ready=1 WHERE id=?").run(id);
            this.notice(room!, `room-invite:${id}`, "You were added to a room with Kenan", actor);
          })();
        }
        void this.deliver();
        return Response.json({ room: this.visible(room) }, { status: 201 });
      });
    }
    const match = /^\/v1\/rooms\/([0-9a-f-]{36})(?:\/(members|prompt|abort|questions\/[^/]+\/answer))?$/.exec(url.pathname);
    if (!match) return fail("Unknown room route", 404);
    const id = match[1]!, action = match[2];
    return this.serialized(id, async () => {
      let room = this.get(id);
      if (!room?.ready || !room.members.some(member => member.user === actor)) return fail("Room not found", 404);
      if (room.owner !== ROOM_CUSTODIAN) return fail("This room needs custody migration into the unprivileged room runtime", 503);
      if (!action && req.method === "GET") return this.transport(room.owner, actor, `/v1/room-owner/${id}`, "GET");
      if (action === "members" && req.method === "POST") {
        const members = this.roster([...room.members.map(member => member.user), ...(Array.isArray(body?.members) ? body.members : [null])], actor);
        if (!members) return fail("Known host members required");
        const updated = await this.transport(room.owner, actor, `/v1/room-owner/${id}/members`, "POST", { members });
        if (!updated.ok) return updated;
        this.db.transaction(() => {
          this.db.query("UPDATE rooms SET members=? WHERE id=?").run(JSON.stringify(members), id);
          const added = members.filter(member => !room!.members.some(old => old.user === member.user));
          room = { ...room!, members };
          for (const member of added) this.notice(room, `room-member:${id}:${member.user}`, `${member.displayName} joined the room`, actor);
        })();
        void this.deliver();
        return Response.json({ room: this.visible(room) });
      }
      if ((action === "abort" || action?.startsWith("questions/")) && req.method === "POST") return this.transport(room.owner, actor, `/v1/room-owner/${id}/${action}`, "POST", body);
      if (action === "prompt" && req.method === "POST") {
        if (!uuid(body?.requestId) || typeof body.text !== "string" || !body.text.trim() || body.text.length > 100_000) return fail("A requestId and message are required");
        const sent = await this.transport(room.owner, actor, `/v1/room-owner/${id}/prompt`, "POST", { requestId: body.requestId, text: body.text });
        if (sent.ok) {
          this.notice(room, `room-message:${id}:${body.requestId}`, `${room.members.find(member => member.user === actor)!.displayName} sent a message`, actor);
          void this.deliver();
        }
        return sent;
      }
      return fail("Unknown room operation", 405);
    });
  }
  private delivery: Promise<void> | null = null;
  private deliver(): Promise<void> {
    if (this.delivery) return this.delivery;
    this.delivery = (async () => {
      const rows = this.db.query("SELECT * FROM deliveries WHERE delivered=0 ORDER BY time LIMIT 100").all() as any[];
      await Promise.all(rows.map(async row => {
        try {
          const response = await this.transport(row.person, row.person, `/v1/room-owner/${row.room}/notify`, "POST", { receiptId: row.receipt, title: row.title, body: row.body, time: row.time });
          if (response.ok) this.db.query("UPDATE deliveries SET delivered=1 WHERE receipt=? AND person=?").run(row.receipt, row.person);
          else console.warn(`Room notice ${row.receipt} for ${row.person}: HTTP ${response.status}; retained for retry`);
        } catch (error) { console.warn(`Room notice ${row.receipt} for ${row.person}: ${String(error)}; retained for retry`); }
      }));
    })().finally(() => { this.delivery = null; });
    return this.delivery;
  }
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await Promise.all(this.rows().filter(room => room.ready && room.owner === ROOM_CUSTODIAN).map(async room => {
        try {
          const response = await this.transport(room.owner, room.members[0]!.user, `/v1/room-owner/${room.id}`, "GET");
          if (!response.ok) { console.warn(`Room ${room.id}: HTTP ${response.status}`); return; }
          const snapshot = await response.json() as RoomSnapshot;
          if (snapshot.notificationId) this.notice(room, `room-reply:${room.id}:${snapshot.notificationId}`, "Kenan replied in the room");
          for (const question of snapshot.questions ?? []) this.notice(room, `room-question:${room.id}:${question.id}`, question.question);
        } catch (error) { console.warn(`Room ${room.id}: ${String(error)}`); }
      }));
      await this.deliver();
    } finally { this.busy = false; }
  }
}
