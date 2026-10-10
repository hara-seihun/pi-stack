import type { Database } from "bun:sqlite";
import type { Result } from "pi-orchestrator/api";
import type { ManagerReplies, ManagerRepliesInput } from "../../../packages/orchestrator/src/core/manager-replies";
import type { PhoneResult } from "./phones";

export type PhoneReplyHost = {
  managerId(): string | null;
  read(input: ManagerRepliesInput): Promise<Result<ManagerReplies>>;
  online(deviceId: string): boolean;
  send(deviceId: string, receiptId: string, text: string): Promise<PhoneResult>;
  feedback(message: string | null): void;
};
type DeviceCursor = { device_id: string; manager_id: string; cursor: number; enabled: number };
const failure = (message: string): Result<never> => ({ ok: false, error: { code: "unavailable", message } });

/** Own-person UI delivery only. Canonical native receipts survive either host being offline. */
export class PhoneReplies {
  private readonly enabled = new Set<string>();
  private readonly initializing = new Map<string, Promise<Result<void>>>();
  private operation: Promise<Result<void>> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  constructor(private readonly db: Database, private readonly host: PhoneReplyHost) {
    db.exec("CREATE TABLE IF NOT EXISTS phone_manager_reply_devices(device_id TEXT PRIMARY KEY,manager_id TEXT NOT NULL,cursor INTEGER NOT NULL,enabled INTEGER NOT NULL CHECK(enabled IN (0,1))); CREATE TABLE IF NOT EXISTS phone_manager_reply_outbox(device_id TEXT NOT NULL,reply_id TEXT NOT NULL,text TEXT NOT NULL,time INTEGER NOT NULL,PRIMARY KEY(device_id,reply_id))");
  }
  async bind(deviceId: string, enabled: boolean): Promise<Result<void>> {
    if (this.closed) return failure("Phone reply transport is closed");
    if (!enabled) {
      this.enabled.delete(deviceId);
      this.db.query("UPDATE phone_manager_reply_devices SET enabled=0 WHERE device_id=?").run(deviceId);
      // The person's explicit overlay-off choice cancels unsent presentation,
      // not native work or its durable manager history.
      this.db.query("DELETE FROM phone_manager_reply_outbox WHERE device_id=?").run(deviceId);
      return { ok: true, value: undefined };
    }
    this.enabled.add(deviceId);
    const prior = this.initializing.get(deviceId);
    if (prior) return prior;
    const operation = this.initialize(deviceId).finally(() => this.initializing.delete(deviceId));
    this.initializing.set(deviceId, operation);
    return operation;
  }
  private async initialize(deviceId: string): Promise<Result<void>> {
    const manager = this.host.managerId();
    if (!manager) return failure("Canonical manager is unset for phone reply delivery");
    const previous = this.db.query("SELECT * FROM phone_manager_reply_devices WHERE device_id=?").get(deviceId) as DeviceCursor | null;
    if (previous && previous.manager_id !== manager) return failure("Phone reply custody names a different configured manager");
    if (previous?.enabled === 1) { void this.reconcile(); return { ok: true, value: undefined }; }
    const head = await this.host.read({ after: null, limit: 100 });
    if (!head.ok) return head;
    if (head.value.managerThreadId !== manager || !Number.isSafeInteger(head.value.cursor) || head.value.cursor < 0) return failure("Invalid canonical manager subscription head");
    if (this.closed || !this.enabled.has(deviceId)) return failure("Phone reply subscription was disabled before initialization");
    this.db.query("INSERT INTO phone_manager_reply_devices VALUES(?,?,?,1) ON CONFLICT(device_id) DO UPDATE SET manager_id=excluded.manager_id,cursor=excluded.cursor,enabled=1").run(deviceId, manager, head.value.cursor);
    void this.reconcile();
    return { ok: true, value: undefined };
  }
  start(): void {
    if (this.closed || this.timer) return;
    this.timer = setInterval(() => { void this.reconcile(); }, 1_000);
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.all([...this.initializing.values()]);
    await this.operation;
  }
  reconcile(): Promise<Result<void>> {
    if (this.closed) return Promise.resolve(failure("Phone reply transport is closed"));
    if (this.operation) return this.operation;
    this.operation = this.run().finally(() => { this.operation = null; });
    return this.operation;
  }
  private async run(): Promise<Result<void>> {
    try {
      let delayed: string | null = null;
      const devices = this.db.query("SELECT * FROM phone_manager_reply_devices WHERE enabled=1").all() as DeviceCursor[];
      for (const device of devices) {
        if (this.closed) break;
        if (!this.enabled.has(device.device_id)) continue; // Require the current authenticated device's hello grant.
        if (device.manager_id !== this.host.managerId()) throw new Error("Phone reply manager identity changed with retained custody");
        const result = await this.host.read({ after: device.cursor, limit: 100 });
        if (!result.ok) { delayed = result.error.message; continue; }
        const page = result.value;
        if (page.managerThreadId !== device.manager_id || !Number.isSafeInteger(page.cursor) || page.cursor < device.cursor) throw new Error("Manager reply cursor or identity changed");
        if (this.closed || !this.enabled.has(device.device_id)) continue;
        this.db.transaction(() => {
          const current = this.db.query("SELECT cursor,enabled FROM phone_manager_reply_devices WHERE device_id=?").get(device.device_id) as { cursor: number; enabled: number };
          if (!current.enabled || current.cursor !== device.cursor) return;
          for (const reply of page.replies) {
            const previous = this.db.query("SELECT text FROM phone_manager_reply_outbox WHERE device_id=? AND reply_id=?").get(device.device_id, reply.id) as { text: string } | null;
            if (previous && previous.text !== reply.text) throw new Error("Manager reply receipt has conflicting content");
            this.db.query("INSERT OR IGNORE INTO phone_manager_reply_outbox VALUES(?,?,?,?)").run(device.device_id, reply.id, reply.text, reply.time);
          }
          this.db.query("UPDATE phone_manager_reply_devices SET cursor=? WHERE device_id=?").run(page.cursor, device.device_id);
        })();
        const pending = this.db.query("SELECT reply_id,text FROM phone_manager_reply_outbox WHERE device_id=? ORDER BY time,rowid").all(device.device_id) as { reply_id: string; text: string }[];
        for (const reply of pending) {
          if (this.closed || !this.enabled.has(device.device_id) || !this.host.online(device.device_id)) break;
          const sent = await this.host.send(device.device_id, reply.reply_id, reply.text);
          if (!sent.ok) { delayed = `Phone reply remains pending: ${sent.error.code}: ${sent.error.message}`; break; }
          const displayed = sent.result as { displayed?: unknown; receiptId?: unknown } | null;
          if (!displayed || displayed.displayed !== true || displayed.receiptId !== reply.reply_id) { delayed = "Phone did not acknowledge the displayed reply receipt; pending delivery retained"; break; }
          this.db.query("DELETE FROM phone_manager_reply_outbox WHERE device_id=? AND reply_id=?").run(device.device_id, reply.reply_id);
        }
      }
      this.host.feedback(delayed);
      return delayed ? failure(delayed) : { ok: true, value: undefined };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.host.feedback(message);
      return failure(message);
    }
  }
}
