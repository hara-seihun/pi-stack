import { Database } from "bun:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { MEMORY_TOKEN_HEADER, type RootAdmission, type MemoryResult } from "kenan-memory/contract";
import type { RootExecutor, RootExecution } from "./root-runtime.js";
import { CONSENT_PREFIX, ROOT_CONSENT_HEADER, type ConsentBridge, type ConsentResult, type ConsentQuestionReceipt, consentInboxId } from "./consent-contract.js";

export interface ConsentInput { subject: string; question: string }
export type ConsentRequest = (input: ConsentInput) => Promise<ConsentResult<{ delivered: true; consentId: string }>>;
export interface NotificationInput { recipient: string; text: string; subjects: string[]; obviouslyPrivate: boolean }
export type NotificationRequest = (toolCallId: string, input: NotificationInput) => Promise<ConsentResult<{ queued: true; delivered: boolean; notificationId: string }>>;
interface PendingNotification {
  id: string; rootSessionId: string; input: NotificationInput;
  state: "queued" | "logged" | "delivered" | "failed"; lastError?: string;
}
type StoredAdmission = Omit<RootAdmission, "memoryToken">;
interface PendingConsent {
  id: string; original: StoredAdmission; request: string; subject: string; question: string;
  state: "queued" | "waiting" | "answered" | "decided" | "delivered";
  receipt?: ConsentQuestionReceipt; answer?: string; resumedRootSessionId?: string; chosen?: RootExecution;
  lastError?: string;
}
export type RootMemoryRpc = <T>(path: string, body: unknown) => Promise<MemoryResult<T>>;
export function rootMemoryRpc(url: string, token: string, transport: typeof fetch = fetch): RootMemoryRpc {
  return async <T>(path: string, body: unknown): Promise<MemoryResult<T>> => {
    try {
      const response = await transport(new URL(path, url), { method: "POST", headers: { "content-type": "application/json", [MEMORY_TOKEN_HEADER]: token }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
      const result = await response.json();
      if (response.ok && result?.ok === true) return result;
      if (result?.ok === false && ["invalid-request", "unauthenticated"].includes(result.error)) return { ok: false, error: result.error, message: "Root accounting rejected this operation" };
      return { ok: false, error: "unavailable", message: "Root consent accounting is unavailable" };
    } catch { return { ok: false, error: "unavailable", message: "Root consent accounting is unavailable" }; }
  };
}
export function createConsentBridge(url: string, token: string, transport: typeof fetch = fetch): ConsentBridge {
  const origin = new URL(url);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.pathname !== "/" || origin.username || origin.password || origin.search || origin.hash || !/^[0-9a-f]{64}$/.test(token)) throw new Error("Consent requires a local router and separate root capability");
  const rpc = async <T>(operation: string, body: unknown): Promise<ConsentResult<T>> => {
    try {
      const response = await transport(new URL(`${CONSENT_PREFIX}${operation}`, origin), { method: "POST", headers: { "content-type": "application/json", [ROOT_CONSENT_HEADER]: token }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
      const result = await response.json();
      return response.ok && result?.ok === true ? result : { ok: false, message: "Consent delivery was not acknowledged; the durable outbox will retry" };
    } catch { return { ok: false, message: "Consent delivery was not acknowledged; the durable outbox will retry" }; }
  };
  return { question: input => rpc("question", input), answer: input => rpc("answer", input), reply: input => rpc("reply", input), notify: input => rpc("notify", input) };
}

export class RootConsentManager {
  private readonly db: Database;
  private readonly operations = new Map<string, Promise<unknown>>();
  constructor(path: string, private readonly options: { bridge: ConsentBridge; memory: RootMemoryRpc; executor: RootExecutor; enabled(): boolean }) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true, strict: true });
    chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS root_consent(id TEXT PRIMARY KEY,data TEXT NOT NULL,state TEXT NOT NULL,updated_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS root_notification(id TEXT PRIMARY KEY,data TEXT NOT NULL,state TEXT NOT NULL,updated_at INTEGER NOT NULL)");
  }
  close(): void { this.db.close(); }
  private get(id: string): PendingConsent { return JSON.parse((this.db.query("SELECT data FROM root_consent WHERE id=?").get(id) as { data: string }).data); }
  private save(row: PendingConsent): void { this.db.query("INSERT INTO root_consent(id,data,state,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,state=excluded.state,updated_at=excluded.updated_at").run(row.id, JSON.stringify(row), row.state, Date.now()); }
  private async serial<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.operations.get(id) ?? Promise.resolve();
    const next = prior.then(operation, operation); this.operations.set(id, next);
    try { return await next; } finally { if (this.operations.get(id) === next) this.operations.delete(id); }
  }
  async request(admission: RootAdmission, request: string, input: ConsentInput): Promise<ConsentResult<{ delivered: true; consentId: string }>> {
    if (!this.options.enabled()) return { ok: false, message: "Root consent is disabled; nobody was asked" };
    if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(input.subject) || !input.question.trim() || Buffer.byteLength(input.question) > 16_000) return { ok: false, message: "Consent needs a registered subject and a concrete, narrow question" };
    const question = `${input.question}\n\nAuthenticated requester: ${admission.person}\n\nChosen answer would go to: ${admission.recipients.join(", ")}\n\nYour answer returns privately to Kenan, who decides what to share for this request. Skipping is not permission.`;
    const existing = (this.db.query("SELECT data FROM root_consent WHERE json_extract(data,'$.original.rootSessionId')=? AND json_extract(data,'$.subject')=? AND json_extract(data,'$.question')=? LIMIT 1").get(admission.rootSessionId, input.subject, question) as { data: string } | null);
    const { memoryToken: _token, ...original } = admission;
    const row: PendingConsent = existing ? JSON.parse(existing.data) : { id: randomUUID(), original, request, subject: input.subject, question, state: "queued" };
    if (!existing) this.save(row);
    return this.serial(row.id, async () => {
      const current = this.get(row.id);
      if (current.state === "queued") {
        const delivery = await this.dispatch(current);
        if (!delivery.ok) return delivery;
      }
      if (current.state === "waiting" || current.state === "answered" || current.state === "decided" || current.state === "delivered")
        return { ok: true, value: { delivered: true, consentId: row.id } };
      return { ok: false, message: "Invalid stored consent state; question delivery is not confirmed" };
    });
  }
  private async log(row: PendingConsent, kind: "question" | "answer", text: string): Promise<ConsentResult<void>> {
    const result = await this.options.memory("/v1/root/log-consent", { rootSessionId: row.original.rootSessionId, consentId: row.id, subject: row.subject, kind, text });
    return result.ok ? { ok: true, value: undefined } : { ok: false, message: result.message };
  }
  private async dispatch(row: PendingConsent): Promise<ConsentResult<void>> {
    const logged = await this.log(row, "question", row.question);
    if (!logged.ok) { row.lastError = logged.message; this.save(row); return logged; }
    const delivered = await this.options.bridge.question({ consentId: row.id, subject: row.subject, text: row.question });
    if (!delivered.ok) { row.lastError = delivered.message; this.save(row); return delivered; }
    row.receipt = delivered.value; row.state = "waiting"; delete row.lastError; this.save(row);
    return { ok: true, value: undefined };
  }
  private saveNotification(row: PendingNotification): void {
    this.db.query("INSERT INTO root_notification(id,data,state,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,state=excluded.state,updated_at=excluded.updated_at").run(row.id, JSON.stringify(row), row.state, Date.now());
  }
  async notify(admission: RootAdmission, toolCallId: string, input: NotificationInput): ReturnType<NotificationRequest> {
    if (!this.options.enabled()) return { ok: false, message: "Root notifications are disabled; nothing was queued" };
    if (!toolCallId || !/^[a-z_][a-z0-9_-]{0,31}$/.test(input.recipient) || !input.text.trim() || Buffer.byteLength(input.text) > 24_000
      || !Array.isArray(input.subjects) || !input.subjects.length || input.subjects.length > 100 || input.subjects.some(id => !/^[a-z_][a-z0-9_-]{0,31}$/.test(id)) || typeof input.obviouslyPrivate !== "boolean")
      return { ok: false, message: "Notification requires a registered recipient, exact text, subjects and privacy classification" };
    const id = consentInboxId(`notification:${admission.rootSessionId}:${toolCallId}`);
    return this.serial(id, async () => {
      const stored = this.db.query("SELECT data FROM root_notification WHERE id=?").get(id) as { data: string } | null;
      const row: PendingNotification = stored ? JSON.parse(stored.data) : { id, rootSessionId: admission.rootSessionId, input, state: "queued" };
      if (JSON.stringify(row.input) !== JSON.stringify(input)) return { ok: false, message: "This notification identity already belongs to different content" };
      if (!stored) this.saveNotification(row);
      try {
        const result = await this.advanceNotification(row);
        if (!result.ok) { row.lastError = result.message; this.saveNotification(row); }
      } catch { row.lastError = "Notification reconciliation failed; durable custody retained"; this.saveNotification(row); }
      if (row.state === "failed") return { ok: false, message: row.lastError ?? "Notification was rejected; nothing was delivered" };
      return { ok: true, value: { queued: true, delivered: row.state === "delivered", notificationId: id } };
    });
  }
  private async advanceNotification(row: PendingNotification): Promise<ConsentResult<void>> {
    if (row.state === "queued") {
      const logged = await this.options.memory("/v1/root/log-notification", { rootSessionId: row.rootSessionId, notificationId: row.id, ...row.input });
      if (!logged.ok) {
        if (logged.error === "invalid-request" || logged.error === "unauthenticated") row.state = "failed";
        return { ok: false, message: logged.message };
      }
      row.state = "logged"; delete row.lastError; this.saveNotification(row);
    }
    if (row.state === "logged") {
      if (!this.options.bridge.notify) return { ok: false, message: "Notification delivery bridge is unavailable" };
      const sent = await this.options.bridge.notify({ consentId: row.id, person: row.input.recipient, text: row.input.text });
      if (!sent.ok) return sent;
      row.state = "delivered"; delete row.lastError; this.saveNotification(row);
    }
    if (row.state === "delivered") return { ok: true, value: undefined };
    if (row.state === "failed") return { ok: false, message: row.lastError ?? "Notification was rejected; nothing was delivered" };
    return { ok: false, message: "Invalid stored notification state; nothing was delivered" };
  }
  async drain(): Promise<{ pending: number; delivered: number; errors: number }> {
    const notifications = this.db.query("SELECT id FROM root_notification WHERE state NOT IN ('delivered','failed') ORDER BY updated_at LIMIT 32").all() as { id: string }[];
    let notificationDelivered = 0, notificationErrors = 0;
    if (this.options.enabled()) await Promise.all(notifications.map(({ id }) => this.serial(id, async () => {
      const row: PendingNotification = JSON.parse((this.db.query("SELECT data FROM root_notification WHERE id=?").get(id) as { data: string }).data);
      try {
        const result = await this.advanceNotification(row);
        if (!result.ok) { row.lastError = result.message; this.saveNotification(row); notificationErrors++; }
        else if (row.state === "delivered") notificationDelivered++;
      } catch { row.lastError = "Notification reconciliation failed; durable custody retained"; this.saveNotification(row); notificationErrors++; }
    })));
    const rows = this.db.query("SELECT id FROM root_consent WHERE state!='delivered' ORDER BY updated_at LIMIT 32").all() as { id: string }[];
    let delivered = notificationDelivered, errors = notificationErrors;
    if (!this.options.enabled()) return { pending: rows.length + notifications.length, delivered, errors };
    for (const { id } of rows) await this.serial(id, async () => {
      const row = this.get(id);
      try {
        const advanced = await this.advance(row);
        if (!advanced.ok) { row.lastError = advanced.message; this.save(row); errors++; }
        else if (row.state === "delivered") delivered++;
      } catch { row.lastError = "Consent reconciliation failed; the durable record is retained"; this.save(row); errors++; }
    });
    return { pending: rows.length + notifications.length - delivered, delivered, errors };
  }
  private async advance(row: PendingConsent): Promise<ConsentResult<void>> {
    if (row.state === "queued") return this.dispatch(row);
    if (row.state === "waiting") {
      const answer = await this.options.bridge.answer({ consentId: row.id, subject: row.subject, ...row.receipt! });
      if (!answer.ok) return answer;
      if (answer.value.question !== row.question) return { ok: false, message: "Subject's question does not match the recorded consent" };
      if (!answer.value.answer) { this.save(row); return { ok: true, value: undefined }; }
      row.answer = JSON.stringify(answer.value.answer); row.state = "answered"; this.save(row);
    }
    if (row.state === "answered") {
      const logged = await this.log(row, "answer", row.answer!); if (!logged.ok) return logged;
      const resumed = await this.options.memory<RootAdmission>("/v1/root/resume-consent", { rootSessionId: row.original.rootSessionId, subject: row.subject, question: row.question, answer: row.answer, consentId: row.id });
      if (!resumed.ok) return { ok: false, message: resumed.message };
      const reply = await this.options.executor(resumed.value, `Reconsider the original request using the subject's exact human answer below. Consent is scoped to this question and audience, not a blanket release. Dismissal or refusal is not permission. Do not ask this same question again. Select the final reply for the original requester's existing thread.\n${JSON.stringify({ originalRequest: row.request, subject: row.subject, question: row.question, humanAnswer: JSON.parse(row.answer!) })}`);
      if (!reply.ok) return { ok: false, message: reply.message };
      row.chosen = reply.value; row.resumedRootSessionId = resumed.value.rootSessionId; row.state = "decided"; this.save(row);
    }
    if (row.state === "decided") {
      const committed = await this.options.memory("/v1/root/finalize-reply", { rootSessionId: row.resumedRootSessionId, reply: row.chosen!.reply, recipients: row.original.recipients, subjects: row.chosen!.subjects });
      if (!committed.ok) return { ok: false, message: committed.message };
      const delivery = await this.options.bridge.reply({ consentId: row.id, person: row.original.person, threadId: row.original.threadId, reply: row.chosen!.reply });
      if (!delivery.ok) return delivery;
      row.state = "delivered"; delete row.lastError; this.save(row);
    }
    if (row.state === "delivered") return { ok: true, value: undefined };
    return { ok: false, message: "Invalid stored consent state; no reply was delivered" };
  }
}
