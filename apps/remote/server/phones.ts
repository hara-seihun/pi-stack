import { API } from "./api";
import { actionJournal, journalWarning, type ActionTicket, type ActionJournal } from "kenan-memory/journal";
import { OVERLAY_MAX_MESSAGE, PHONE_MAX_FRAME_BYTES, phoneCatalogue, validatePhoneCommand } from "./phone-commands";

export type PhoneDevice = { id: string; name: string; model: string; android: string; capabilities: Record<string, unknown> };
export type PhoneResult = ({ type: "result"; id: string; ok: true; result: unknown } | { type: "result"; id: string; ok: false; error: { code: string; message: string } }) & { journalWarning?: string };
export type PhoneTransport = { send(frame: string): number | void; close(code: number, reason: string): void };
type Pending = { settle(result: PhoneResult): void; timer: ReturnType<typeof setTimeout>; abort?: () => void };
export type PhoneConnection = { transport: PhoneTransport; device?: PhoneDevice; pending: Map<string, Pending>; closed: boolean; helloTimer?: ReturnType<typeof setTimeout> };
export type PhoneSocketData = { kind: "phone"; connection?: PhoneConnection };
type Registered = { device: PhoneDevice; lastSeen: number; connection?: PhoneConnection };
/** A person typed to Kenan in the phone overlay. */
export type OverlayMessage = { id: string; text: string; context: { package: string | null; label: string | null } };
export type OverlayAck = { ok: true; threadId: string } | { ok: false; error: { code: string; message: string } };
export type PhoneHooks = { overlayMessage?(device: PhoneDevice, message: OverlayMessage): Promise<OverlayAck>; ready?(device: PhoneDevice): void; commandUsed?(command: string): void; journal?: Pick<ActionJournal, "begin" | "finish"> };
const failure = (id: string, code: string, message: string): PhoneResult => ({ type: "result", id, ok: false, error: { code, message } });
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);

export function phoneCallerAllowed(caller: { kind: string; uid?: number; error?: string }, ownerUid: number, connect = false): boolean {
  if (caller.error) return false;
  if (caller.kind === "person") return true;
  if (connect) return false;
  return caller.kind === "thread" || caller.kind === "runtime" || caller.kind === "service" || (caller.kind === "process" && caller.uid === ownerUid);
}

export class PhoneBroker {
  private readonly devices = new Map<string, Registered>();
  private readonly connections = new Set<PhoneConnection>();
  private stopped = false;
  constructor(private readonly hooks: PhoneHooks = {}) {}

  open(transport: PhoneTransport): PhoneConnection {
    const connection: PhoneConnection = { transport, pending: new Map(), closed: false };
    if (this.stopped) { connection.closed = true; transport.close(1012, "Supervisor stopped"); return connection; }
    this.connections.add(connection);
    connection.helloTimer = setTimeout(() => this.close(connection, 1008, "Phone hello required"), 5_000);
    return connection;
  }

  receive(connection: PhoneConnection, message: string | Uint8Array | ArrayBuffer): void {
    if (connection.closed) return;
    const text = typeof message === "string" ? message : new TextDecoder().decode(message);
    if (Buffer.byteLength(text) > PHONE_MAX_FRAME_BYTES) { this.close(connection, 1009, "Phone frame too large"); return; }
    let frame: unknown;
    try { frame = JSON.parse(text); } catch { this.close(connection, 1008, "Invalid phone JSON"); return; }
    if (!object(frame)) { this.close(connection, 1008, "Invalid phone frame"); return; }
    if (frame.type === "hello") {
      const device = frame.device;
      if (!object(device) || typeof device.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(device.id)
        || [device.name, device.model, device.android].some(value => typeof value !== "string" || value.length > 256)
        || !object(device.capabilities) || (connection.device && device.id !== connection.device.id)) {
        this.close(connection, 1008, "Invalid or changed phone identity"); return;
      }
      clearTimeout(connection.helloTimer);
      const previous = this.devices.get(device.id)?.connection;
      if (previous && previous !== connection) this.close(previous, 1012, "Phone connection replaced");
      connection.device = { id: device.id, name: device.name, model: device.model, android: device.android, capabilities: device.capabilities };
      this.devices.set(device.id, { device: connection.device, lastSeen: Date.now(), connection });
      try { if (connection.transport.send(JSON.stringify({ type: "ready" })) === 0) this.close(connection, 1011, "Phone send failed"); }
      catch { this.close(connection, 1011, "Phone send failed"); }
      if (!connection.closed) this.hooks.ready?.(connection.device);
      return;
    }
    if (connection.device && frame.type === "heartbeat") {
      const registered = this.devices.get(connection.device.id);
      if (registered?.connection !== connection) { this.close(connection, 1008, "Phone connection replaced"); return; }
      registered.lastSeen = Date.now();
      try { if (connection.transport.send(JSON.stringify({ type: "ready" })) === 0) this.close(connection, 1011, "Phone send failed"); }
      catch { this.close(connection, 1011, "Phone send failed"); }
      return;
    }
    if (connection.device && frame.type === "overlay.message") { this.overlayMessage(connection, connection.device, frame); return; }
    if (!connection.device || frame.type !== "result" || typeof frame.id !== "string" || typeof frame.ok !== "boolean"
      || (!frame.ok && (!object(frame.error) || typeof frame.error.code !== "string" || typeof frame.error.message !== "string"))
      || (frame.ok && !("result" in frame))) { this.close(connection, 1008, "Invalid phone result"); return; }
    const registered = this.devices.get(connection.device.id);
    if (registered?.connection === connection) registered.lastSeen = Date.now();
    connection.pending.get(frame.id)?.settle(frame as PhoneResult);
  }

  private overlayMessage(connection: PhoneConnection, device: PhoneDevice, frame: Record<string, any>): void {
    const id = frame.id, text = frame.text, context = frame.context ?? {};
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) { this.close(connection, 1008, "Invalid overlay message"); return; }
    const reply = (ack: OverlayAck) => { if (!connection.closed) try { connection.transport.send(JSON.stringify({ type: "overlay.ack", id, ...ack })); } catch {} };
    const name = (value: unknown) => typeof value === "string" && value.length <= 256 ? value : null;
    if (typeof text !== "string" || !text.trim() || text.length > OVERLAY_MAX_MESSAGE || !object(context)) {
      reply({ ok: false, error: { code: "invalid_request", message: `Message must be 1..${OVERLAY_MAX_MESSAGE} characters` } }); return;
    }
    if (!this.hooks.overlayMessage) { reply({ ok: false, error: { code: "unsupported", message: "This supervisor does not accept overlay messages" } }); return; }
    this.hooks.overlayMessage(device, { id, text: text.trim(), context: { package: name(context.package), label: name(context.label) } })
      .then(reply, (cause: unknown) => reply({ ok: false, error: { code: "unavailable", message: cause instanceof Error ? cause.message : String(cause) } }));
  }

  /** Send a command without waiting on the caller; resolves to the phone's result. */
  send(deviceId: string, command: string, args: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<PhoneResult> { return this.execute(deviceId, { command, args, timeoutMs }); }
  online(deviceId: string): boolean { const connection = this.devices.get(deviceId)?.connection; return !!connection && !connection.closed; }

  disconnected(connection: PhoneConnection): void {
    if (connection.closed) return;
    connection.closed = true;
    clearTimeout(connection.helloTimer);
    this.connections.delete(connection);
    const registered = connection.device && this.devices.get(connection.device.id);
    if (registered?.connection === connection) { registered.connection = undefined; registered.lastSeen = Date.now(); }
    for (const [id, pending] of connection.pending) pending.settle(failure(id, "unconfirmed", "Phone disconnected after dispatch; execution may have happened. Nothing was retried."));
  }

  private close(connection: PhoneConnection, code: number, reason: string): void {
    this.disconnected(connection);
    connection.transport.close(code, reason);
  }

  list() { return { phones: [...this.devices.values()].map(({ device, lastSeen, connection }) => ({ ...device, connected: !!connection && !connection.closed, lastSeen })) }; }

  async execute(deviceId: string, input: unknown, signal?: AbortSignal): Promise<PhoneResult> {
    const id = crypto.randomUUID();
    const parsed = validatePhoneCommand(input);
    if (!parsed.ok) return failure(id, parsed.error.code, parsed.error.message);
    const connection = this.devices.get(deviceId)?.connection;
    if (!connection || connection.closed || this.stopped) return failure(id, "disconnected", "Phone is offline; command was not dispatched or queued");
    if (signal?.aborted) return failure(id, "cancelled", "Caller disconnected before dispatch");
    if (connection.pending.size >= 32) return failure(id, "busy", "Phone already has 32 commands in flight; command was not dispatched");
    const { command, args, timeoutMs } = parsed;
    let ticket: ActionTicket | null = null;
    if (["sms.send", "call.dial", "calendar.insert", "notifications.reply"].includes(command)) {
      try { ticket = (this.hooks.journal ?? actionJournal).begin({ action: `phone.${command}`, recipients: [String(args.to ?? args.number ?? args.calendarId ?? deviceId)], summary: String(args.text ?? args.title ?? "Requested telephone dialing; not confirmation of a connected call") }); }
      catch (cause) { return failure(id, "journal_unavailable", `Not dispatched: ${String(cause)}`); }
    }
    return new Promise(resolve => {
      const settle = (result: PhoneResult) => {
        const pending = connection.pending.get(id);
        if (!pending) return;
        connection.pending.delete(id);
        clearTimeout(pending.timer);
        if (pending.abort) signal?.removeEventListener("abort", pending.abort);
        const warning = journalWarning((this.hooks.journal ?? actionJournal).finish(ticket, result.ok ? "confirmed" : result.error.code === "unconfirmed" ? "unconfirmed" : "failed", result.ok ? `${command} accepted by Android; not proof of carrier delivery or connected call` : result.error.message));
        if (result.ok && !command.startsWith("overlay.")) this.hooks.commandUsed?.(command);
        resolve(warning ? { ...result, journalWarning: warning } : result);
      };
      const pending: Pending = { settle, timer: setTimeout(() => settle(failure(id, "unconfirmed", "Phone did not confirm before the deadline; execution may have happened. Nothing was retried.")), timeoutMs) };
      if (signal) { pending.abort = () => settle(failure(id, "unconfirmed", "Caller disconnected after dispatch; execution may have happened. Nothing was retried.")); signal.addEventListener("abort", pending.abort, { once: true }); }
      connection.pending.set(id, pending);
      try {
        if (connection.transport.send(JSON.stringify({ type: "command", id, command, args, deadline: Date.now() + timeoutMs })) === 0) {
          settle(failure(id, "disconnected", "Transport rejected the command; command was not dispatched"));
          this.close(connection, 1011, "Phone send failed");
        }
      } catch {
        settle(failure(id, "unconfirmed", "Transport failed during dispatch; execution may have happened. Nothing was retried."));
        this.close(connection, 1011, "Phone send failed");
      }
    });
  }

  stop(): void { this.stopped = true; for (const connection of this.connections) this.close(connection, 1012, "Supervisor handoff"); }

  async handle(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    if (API.phones.match(req.method, url.pathname)) return Response.json(this.list());
    if (API.phoneCommands.match(req.method, url.pathname)) return Response.json(phoneCatalogue());
    const match = API.phoneCommand.match(req.method, url.pathname);
    if (!match) return null;
    let input: unknown;
    try {
      const reader = req.body?.getReader();
      if (!reader) return Response.json(failure(crypto.randomUUID(), "invalid_request", "Expected JSON command"), { status: 400 });
      const chunks: Uint8Array[] = []; let size = 0;
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        size += next.value.byteLength;
        if (size > PHONE_MAX_FRAME_BYTES - 1024) { await reader.cancel(); return Response.json(failure(crypto.randomUUID(), "invalid_request", "Phone command too large"), { status: 413 }); }
        chunks.push(next.value);
      }
      input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch { return Response.json(failure(crypto.randomUUID(), "invalid_request", "Expected JSON command"), { status: 400 }); }
    const result = await this.execute(match.phoneId!, input, req.signal);
    const status = result.ok ? 200 : ({ invalid_request: 400, unsupported: 400, disconnected: 409, busy: 429, unconfirmed: 504, cancelled: 499 } as Record<string, number>)[result.error.code] ?? 422;
    return Response.json(result, { status });
  }
}
