import type { DatabaseSync } from "node:sqlite";
import type { Result, SendThread, ThreadApi } from "../threads/contracts.js";

type NoticeApi = Pick<ThreadApi, "settlements" | "attentionEvents" | "questionEvents" | "list">;
type NoticeDirectory = Pick<ThreadApi, "managerNotificationPolicy" | "send">;
export type CoreManagerNoticesConfig = {
  scopeId: string;
  /** Former notification owner ID; retains existing manager-notice request identities. */
  notificationOwnerId: string;
  adoptedCursors: { settlements: number; attention: number; questions: number };
  subscribe: (listener: () => void) => () => void;
  feedback: (message: string | null) => void;
};
const failure = (message: string): Result<never> => ({ ok: false, error: { code: "unavailable", message } });

/** Durable core routing; Remote only projects these receipts for UI/Android fanout. */
export class CoreManagerNotices {
  private detach: (() => void) | null = null;
  private closed = false;
  private operation: Promise<Result<void>> | null = null;
  private dirty = false;
  private recovery: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly config: CoreManagerNoticesConfig, private readonly db: DatabaseSync,
    private readonly api: NoticeApi, private readonly directory: NoticeDirectory) {
    if (!config.scopeId || !config.notificationOwnerId || Object.values(config.adoptedCursors).some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error("Manager notices require explicit scope, former owner and adopted receipt cursors");
    db.exec("CREATE TABLE IF NOT EXISTS core_manager_notice_cursor(scope_id TEXT NOT NULL,kind TEXT NOT NULL,cursor INTEGER NOT NULL,PRIMARY KEY(scope_id,kind)); CREATE TABLE IF NOT EXISTS core_manager_notice_outbox(scope_id TEXT NOT NULL,request_id TEXT NOT NULL,input TEXT NOT NULL,error TEXT,PRIMARY KEY(scope_id,request_id))");
    for (const [kind, cursor] of Object.entries(config.adoptedCursors)) db.prepare("INSERT OR IGNORE INTO core_manager_notice_cursor VALUES(?,?,?)").run(config.scopeId, kind, cursor);
  }
  async start(): Promise<Result<void>> {
    if (this.closed) return failure("Manager notice adapter is closed");
    if (!this.detach) this.detach = this.config.subscribe(() => { void this.reconcile(); });
    return this.reconcile();
  }
  async close(): Promise<void> {
    this.closed = true;
    this.detach?.(); this.detach = null;
    if (this.recovery) clearTimeout(this.recovery);
    this.recovery = null;
    await this.operation;
  }
  reconcile(): Promise<Result<void>> {
    if (this.closed) return Promise.resolve(failure("Manager notice adapter is closed"));
    if (this.operation) { this.dirty = true; return this.operation; }
    this.operation = this.run().finally(() => {
      this.operation = null;
      if (this.closed) return;
      if (this.dirty) { this.dirty = false; void this.reconcile(); }
    });
    return this.operation;
  }
  private cursor(kind: string): number {
    return (this.db.prepare("SELECT cursor FROM core_manager_notice_cursor WHERE scope_id=? AND kind=?").get(this.config.scopeId, kind) as { cursor: number }).cursor;
  }
  private checkpoint(kind: string, cursor: number, messages: SendThread[]): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const message of messages) {
        const input = JSON.stringify(message);
        const prior = this.db.prepare("SELECT input FROM core_manager_notice_outbox WHERE scope_id=? AND request_id=?").get(this.config.scopeId, message.requestId) as { input: string } | undefined;
        if (prior && prior.input !== input) throw new Error("Manager notice request identity has conflicting content");
        this.db.prepare("INSERT OR IGNORE INTO core_manager_notice_outbox VALUES(?,?,?,NULL)").run(this.config.scopeId, message.requestId, input);
      }
      this.db.prepare("UPDATE core_manager_notice_cursor SET cursor=? WHERE scope_id=? AND kind=?").run(cursor, this.config.scopeId, kind);
      this.db.exec("COMMIT");
    } catch (cause) { this.db.exec("ROLLBACK"); throw cause; }
  }
  private async scan(kind: "settlements" | "attention" | "questions", managerThreadId: string | null): Promise<void> {
    for (;;) {
      if (this.closed) return;
      const after = this.cursor(kind);
      const result = kind === "settlements" ? await this.api.settlements(after, 100)
        : kind === "attention" ? await this.api.attentionEvents(after, 100) : await this.api.questionEvents(after, 100);
      if (!result.ok) throw new Error(result.error.message);
      const page = result.value;
      if (!Number.isSafeInteger(page.cursor) || page.cursor < after) throw new Error("Manager notice receipt cursor regressed");
      if (page.cursor === after) return;
      const messages: SendThread[] = [];
      if (managerThreadId) for (const receipt of page.items) {
        if (receipt.threadId === managerThreadId) continue;
        const listed = await this.api.list({ id: receipt.threadId, limit: 1 });
        if (!listed.ok) throw new Error(listed.error.message);
        const thread = listed.value.threads.find(thread => thread.id === receipt.threadId);
        if (!thread) throw new Error(`Manager notice names missing thread ${receipt.threadId}`);
        let requestId: string, text: string;
        if ("executionId" in receipt) {
          if (receipt.assignmentPending || !receipt.finalMessage && receipt.outcome === "complete") continue;
          requestId = `manager-notice:${this.config.notificationOwnerId}:settlement:${receipt.executionId}`;
          text = JSON.stringify({ type: "thread_settled", threadId: thread.id, title: thread.title, outcome: receipt.outcome, finalMessage: receipt.finalMessage, error: receipt.error });
        } else if ("summary" in receipt) {
          requestId = `manager-notice:${this.config.notificationOwnerId}:attention:${receipt.seq}`;
          text = `Attention from ${thread.title} (${thread.id}): ${receipt.summary}\nOnly your explicit thread_attention notifies the person.`;
        } else {
          requestId = `manager-notice:${this.config.notificationOwnerId}:question:${receipt.questionId}`;
          text = `Question from ${thread.title} (${thread.id}): ${receipt.question}\nUse manager_questions_list to handle held questions; only your explicit thread_attention notifies the person.`;
        }
        messages.push({ threadId: managerThreadId, senderId: thread.id, requestId, source: "notification", text });
      }
      if (this.closed) return;
      this.checkpoint(kind, page.cursor, messages);
      if (page.items.length < 100) return;
    }
  }
  private async run(): Promise<Result<void>> {
    try {
      const policy = await this.directory.managerNotificationPolicy();
      if (!policy.ok) throw new Error(policy.error.message);
      const manager = policy.value.view === "mono" ? policy.value.managerThreadId : null;
      for (const kind of ["settlements", "attention", "questions"] as const) await this.scan(kind, manager);
      const rows = this.db.prepare("SELECT request_id,input FROM core_manager_notice_outbox WHERE scope_id=? ORDER BY rowid").all(this.config.scopeId) as { request_id: string; input: string }[];
      for (const row of rows) {
        if (this.closed) return failure("Manager notice adapter closed with pending custody retained");
        const result = await this.directory.send(JSON.parse(row.input));
        if (!result.ok) {
          this.db.prepare("UPDATE core_manager_notice_outbox SET error=? WHERE scope_id=? AND request_id=?").run(result.error.message, this.config.scopeId, row.request_id);
          throw new Error(result.error.message);
        }
        this.db.prepare("DELETE FROM core_manager_notice_outbox WHERE scope_id=? AND request_id=?").run(this.config.scopeId, row.request_id);
      }
      if (this.recovery) clearTimeout(this.recovery);
      this.recovery = null;
      this.config.feedback(null);
      return { ok: true, value: undefined };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.config.feedback(message);
      if (!this.closed && !this.recovery) this.recovery = setTimeout(() => { this.recovery = null; void this.reconcile(); }, 1_000);
      return failure(message);
    }
  }
}
