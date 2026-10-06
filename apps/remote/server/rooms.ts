import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Room, RoomActivity, RoomMember, RoomSnapshot } from "../shared/rooms";

export const ROOM_CUSTODIAN = "pi-rooms";
interface StoredRoom extends Room {
  owner: string;
  creator: string;
  ready: number;
  updatedAt: number;
  state: "idle" | "running";
  pendingQuestions: number;
  questionIds: string;
}
interface Inbox { current: number; unreadCount: number }
type Transport = (owner: string, actor: string, path: string, method: string, body?: unknown) => Promise<Response>;
const fail = (error: string, status = 400) => Response.json({ error }, { status });
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);

/** Host-owned directory and durable notification outbox. Conversation history stays with its thread owner. */
export class Rooms {
  private db: Database;
  private busy = false;
  private locks = new Map<string, Promise<unknown>>();
  private statuses = new Map<string, RoomActivity>();
  constructor(path: string, private people: () => RoomMember[], private transport: Transport) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true });
    // Keep the deployment's named root-reader ACL effective under the router's private umask.
    chmodSync(path, 0o640);
    const hasInbox = this.db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='room_inbox'").get();
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY,owner TEXT NOT NULL,creator TEXT NOT NULL,title TEXT NOT NULL,members TEXT NOT NULL,ready INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS deliveries(receipt TEXT NOT NULL,room TEXT NOT NULL,person TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,time INTEGER NOT NULL,delivered INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(receipt,person));
      CREATE TABLE IF NOT EXISTS room_activity(receipt TEXT PRIMARY KEY,room TEXT NOT NULL,time INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS room_prompts(room TEXT NOT NULL,requestId TEXT NOT NULL,actor TEXT NOT NULL,kind TEXT NOT NULL,text TEXT NOT NULL,accepted INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(room,requestId));
      CREATE TABLE IF NOT EXISTS room_inbox(room TEXT NOT NULL,person TEXT NOT NULL,current INTEGER NOT NULL DEFAULT 1,received INTEGER NOT NULL DEFAULT 0,readReceived INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(room,person));`);
    if (!hasInbox) this.db.exec(`INSERT INTO room_inbox(room,person,received)
      SELECT room,person,COUNT(*) FROM deliveries GROUP BY room,person;
      INSERT OR IGNORE INTO room_activity(receipt,room,time) SELECT receipt,room,time FROM deliveries;`);
    const columns = this.db.query("PRAGMA table_info(rooms)").all() as { name: string }[];
    if (!columns.some(column => column.name === "creator")) {
      this.db.exec("ALTER TABLE rooms ADD COLUMN creator TEXT; UPDATE rooms SET creator=owner");
    }
    for (const [name, definition] of [
      ["updatedAt", "INTEGER NOT NULL DEFAULT 0"],
      ["state", "TEXT NOT NULL DEFAULT 'idle'"],
      ["pendingQuestions", "INTEGER NOT NULL DEFAULT 0"],
      ["questionIds", "TEXT NOT NULL DEFAULT '[]'"],
    ]) if (!columns.some(column => column.name === name)) {
      this.db.exec(`ALTER TABLE rooms ADD COLUMN ${name} ${definition}`);
      if (name === "updatedAt") this.db.query("UPDATE rooms SET updatedAt=COALESCE((SELECT MAX(time) FROM deliveries WHERE room=rooms.id),?)").run(Date.now());
    }
    for (const file of [`${path}-wal`, `${path}-shm`]) if (existsSync(file)) chmodSync(file, 0o640);
  }
  close() { this.db.close(); }
  private rows(): StoredRoom[] {
    return (this.db.query("SELECT * FROM rooms ORDER BY rowid").all() as any[]).map(row => ({ ...row, members: JSON.parse(row.members) }));
  }
  private get(id: string): StoredRoom | undefined {
    const row = this.db.query("SELECT * FROM rooms WHERE id=?").get(id) as any;
    return row ? { ...row, members: JSON.parse(row.members) } : undefined;
  }
  private inbox(actor: string, id?: string): Map<string, Inbox> {
    const rows = this.db.query(`SELECT r.id,COALESCE(i.current,1) AS current,COALESCE(i.received-i.readReceived,0) AS unreadCount
      FROM rooms r LEFT JOIN room_inbox i ON i.room=r.id AND i.person=?
      ${id ? "WHERE r.id=?" : ""}`).all(...(id ? [actor, id] : [actor])) as (Inbox & { id: string })[];
    return new Map(rows.map(row => [row.id, row]));
  }
  private visible(room: StoredRoom, actor: string, inbox = this.inbox(actor, room.id).get(room.id)!): Room {
    return { id: room.id, title: room.title, members: room.members, current: inbox.current !== 0,
      updatedAt: room.updatedAt, state: room.state, unreadCount: inbox.unreadCount, pendingQuestions: room.pendingQuestions,
      ...(this.statuses.get(room.id) ?? this.statusFailure(room.id, "Room owner status has not been retrieved")) };
  }
  private setCurrent(id: string, actor: string, current: boolean) {
    this.db.query("INSERT INTO room_inbox(room,person,current) VALUES(?,?,?) ON CONFLICT(room,person) DO UPDATE SET current=excluded.current").run(id, actor, Number(current));
  }
  private roster(users: unknown, actor: string): RoomMember[] | null {
    if (!Array.isArray(users) || users.some(user => typeof user !== "string") || users.length > 63) return null;
    const ids = [...new Set(users)];
    if (!ids.includes(actor)) ids.unshift(actor);
    const people = this.people();
    const members = ids.map(user => people.find(person => person.user === user));
    return members.every(Boolean) ? members as RoomMember[] : null;
  }
  private activity(id: string, receipt: string, time = Date.now()): boolean {
    const fresh = this.db.query("INSERT OR IGNORE INTO room_activity(receipt,room,time) VALUES(?,?,?)").run(receipt, id, time).changes !== 0;
    if (fresh) this.db.query("UPDATE rooms SET updatedAt=MAX(updatedAt,?) WHERE id=?").run(time, id);
    return fresh;
  }
  private notice(room: StoredRoom, receipt: string, body: string, exclude?: string, time = Date.now()) {
    this.db.transaction(() => {
      this.activity(room.id, receipt, time);
      for (const member of room.members) if (member.user !== exclude) {
        const result = this.db.query("INSERT OR IGNORE INTO deliveries(receipt,room,person,title,body,time) VALUES(?,?,?,?,?,?)")
          .run(receipt, room.id, member.user, room.title, body, time);
        if (result.changes) this.db.query(`INSERT INTO room_inbox(room,person,received) VALUES(?,?,1)
          ON CONFLICT(room,person) DO UPDATE SET current=1,received=room_inbox.received+1`).run(room.id, member.user);
      }
    })();
  }
  private statusFailure(id: string, detail: string): RoomActivity {
    const status: RoomActivity = { activity: "status_error", activityDetail: detail, error: detail, activeTools: [] };
    this.statuses.set(id, status);
    return status;
  }
  private async refresh(room: StoredRoom, actor: string): Promise<Response> {
    if (room.owner !== ROOM_CUSTODIAN) {
      this.statusFailure(room.id, "Room status requires custody migration into the unprivileged room runtime");
      return fail("This room needs custody migration into the unprivileged room runtime", 503);
    }
    try {
      const response = await this.transport(room.owner, actor, `/v1/room-owner/${room.id}`, "GET");
      if (!response.ok) {
        const detail = `Room owner status retrieval failed: HTTP ${response.status}`;
        this.statusFailure(room.id, detail);
        return fail(detail, response.status);
      }
      const snapshot = await response.json() as RoomSnapshot;
      this.reconcile(room, snapshot);
      return Response.json({ ...snapshot, room: this.visible(this.get(room.id)!, actor) });
    } catch {
      this.statusFailure(room.id, "Room owner status retrieval failed");
      return fail("Room owner status retrieval failed", 503);
    }
  }
  private reconcile(room: StoredRoom, snapshot: RoomSnapshot) {
    const { activity, activitySince, lastActivityAt, activityDetail, activeTools, executionError, held, error } = snapshot;
    if (!activity || String(activity) === "running") this.statusFailure(room.id, "Room owner did not report an execution phase");
    else this.statuses.set(room.id, { activity, activitySince, lastActivityAt, activityDetail, activeTools, executionError, held, error });
    this.db.transaction(() => {
      const questions = snapshot.questions ?? [];
      this.db.query("UPDATE rooms SET state=?,pendingQuestions=?,questionIds=? WHERE id=?")
        .run(snapshot.state, questions.length, JSON.stringify(questions.map(question => question.id)), room.id);
      if (snapshot.notificationId) this.notice(room, `room-reply:${room.id}:${snapshot.notificationId}`, "Kenan replied in the room");
      for (const question of questions) this.notice(room, `room-question:${room.id}:${question.id}`, question.question, undefined, question.createdAt);
    })();
  }
  private async serialized<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.locks.get(id) ?? Promise.resolve()).catch(() => {}).then(operation);
    this.locks.set(id, next);
    try { return await next; } finally { if (this.locks.get(id) === next) this.locks.delete(id); }
  }
  async handle(req: Request, actor: string, senderKind: "person" | "agent" = "person"): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/v1/rooms" && req.method === "GET") {
      const visible = this.rows().filter(room => room.ready && room.members.some(member => member.user === actor));
      await Promise.all(visible.map(room => this.serialized(room.id, () => this.refresh(this.get(room.id)!, actor))));
      const inbox = this.inbox(actor);
      return Response.json({ rooms: visible.map(room => this.visible(this.get(room.id)!, actor, inbox.get(room.id)!)), people: this.people() });
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
          this.db.query("INSERT INTO rooms(id,owner,creator,title,members,updatedAt) VALUES(?,?,?,?,?,?)").run(id, ROOM_CUSTODIAN, actor, body.title.trim(), JSON.stringify(members), Date.now());
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
        await this.refresh(this.get(id)!, actor);
        void this.deliver();
        return Response.json({ room: this.visible(this.get(id)!, actor) }, { status: 201 });
      });
    }
    const match = /^\/v1\/rooms\/([0-9a-f-]{36})(?:\/(members|prompt|abort|close|open|read|questions\/[^/]+\/answer))?$/.exec(url.pathname);
    if (!match) return fail("Unknown room route", 404);
    const id = match[1]!, action = match[2];
    return this.serialized(id, async () => {
      let room = this.get(id);
      if (!room?.ready || !room.members.some(member => member.user === actor)) return fail("Room not found", 404);
      if ((action === "close" || action === "open" || action === "read") && req.method === "POST") {
        if (action === "read") this.db.query(`INSERT INTO room_inbox(room,person) VALUES(?,?)
          ON CONFLICT(room,person) DO UPDATE SET readReceived=room_inbox.received`).run(id, actor);
        else this.setCurrent(id, actor, action === "open");
        return Response.json({ room: this.visible(room, actor) });
      }
      if (room.owner !== ROOM_CUSTODIAN) return fail("This room needs custody migration into the unprivileged room runtime", 503);
      if (!action && req.method === "GET") return this.refresh(room, actor);
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
        await this.refresh(this.get(id)!, actor);
        void this.deliver();
        return Response.json({ room: this.visible(this.get(id)!, actor) });
      }
      if ((action === "abort" || action?.startsWith("questions/")) && req.method === "POST") {
        const response = await this.transport(room.owner, actor, `/v1/room-owner/${id}/${action}`, "POST", body);
        if (response.ok) {
          if (action !== "abort") {
            const questionId = action.split("/")[1]!;
            this.db.transaction(() => {
              const receipt = `room-answer:${id}:${questionId}`;
              if (this.activity(id, receipt)) {
                const questions = (JSON.parse(room!.questionIds) as string[]).filter(id => id !== questionId);
                this.db.query("UPDATE rooms SET pendingQuestions=?,questionIds=? WHERE id=?")
                  .run(questions.length, JSON.stringify(questions), id);
                this.setCurrent(id, actor, true);
              }
              this.notice(room!, receipt, `${room!.members.find(member => member.user === actor)!.displayName} answered a question`, actor);
            })();
            void this.deliver();
          }
          await this.refresh(this.get(id)!, actor);
        }
        return response;
      }
      if (action === "prompt" && req.method === "POST") {
        if (!uuid(body?.requestId) || typeof body.text !== "string" || !body.text.trim() || body.text.length > 100_000) return fail("A requestId and message are required");
        const previous = this.db.query("SELECT actor,kind,text,accepted FROM room_prompts WHERE room=? AND requestId=?").get(id, body.requestId) as { actor: string; kind: string; text: string; accepted: number } | null;
        if (previous && (previous.actor !== actor || previous.kind !== senderKind || previous.text !== body.text)) return fail("Room message requestId already used", 409);
        if (previous?.accepted) return Response.json({ accepted: true, replayed: true, room: this.visible(room, actor) }, { status: 202 });
        this.db.query("INSERT OR IGNORE INTO room_prompts(room,requestId,actor,kind,text) VALUES(?,?,?,?,?)").run(id, body.requestId, actor, senderKind, body.text);
        const sent = await this.transport(room.owner, actor, `/v1/room-owner/${id}/prompt`, "POST", { requestId: body.requestId, text: body.text, senderKind });
        if (sent.ok) {
          this.db.transaction(() => {
            this.db.query("UPDATE room_prompts SET accepted=1 WHERE room=? AND requestId=?").run(id, body.requestId);
            const receipt = `room-message:${id}:${body.requestId}`;
            if (this.activity(id, receipt)) {
              this.setCurrent(id, actor, true);
            }
            this.notice(room!, receipt, `${room!.members.find(member => member.user === actor)!.displayName}${senderKind === "agent" ? "'s Kenan" : ""} sent a message`, actor);
          })();
          await this.refresh(this.get(id)!, actor);
          void this.deliver();
        }
        return sent.ok ? Response.json({ ...await sent.json(), room: this.visible(this.get(id)!, actor) }, { status: sent.status }) : sent;
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
      await Promise.all(this.rows().filter(room => room.ready && room.owner === ROOM_CUSTODIAN).map(room => this.serialized(room.id, () => {
        const current = this.get(room.id)!;
        return this.refresh(current, current.members[0]!.user);
      })));
      await this.deliver();
    } finally { this.busy = false; }
  }
}
