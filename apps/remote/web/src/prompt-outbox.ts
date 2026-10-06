export type OutboxResult<T> = { ok: true; value: T } | { ok: false; error: PromptOutboxError };
export type PromptOutboxError = {
  kind: "invalid_scope" | "scope_changed" | "invalid_prompt" | "storage_unavailable" | "storage_corrupt"
    | "full" | "conflicting_request" | "not_found" | "pending_not_acknowledged";
  message: string;
};
export type PromptOutboxScope = Readonly<{ person: string; environment: string; bootstrap: string }>;
export type PromptOutboxBody = Readonly<{
  requestId: string;
  text: string;
  delivery: "queue" | "steer" | "hardSteer";
  replyTo?: string;
  includeMeetingImages?: boolean;
}>;
export type PromptOutboxOutcome =
  | { kind: "pending"; reason: "saved" | "transport" | "authentication" | "unconfirmed"; message: string }
  | { kind: "accepted"; workId: string }
  | { kind: "rejected"; message: string };
export type PromptOutboxEntry = Readonly<{
  requestId: string;
  sessionId: string;
  bodyJson: string;
  createdAt: number;
  outcome: PromptOutboxOutcome;
}>;
export type PromptOutboxTransport = (entry: PromptOutboxEntry, signal: AbortSignal) => Promise<{ status: number; body: unknown }>;
export const PROMPT_OUTBOX_LIMITS = Object.freeze({ entries: 64, bytes: 2 * 1024 * 1024 });
const DATABASE = "pi-remote-prompt-outbox";
const STORE = "prompts";
const RETAINED_MESSAGE_BYTES = 4096;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type StoredEntry = PromptOutboxEntry & { key: string; scope: string };
const good = <T>(value: T): OutboxResult<T> => ({ ok: true, value });
const bad = (kind: PromptOutboxError["kind"], message: string): OutboxResult<never> => ({ ok: false, error: { kind, message } });
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 512);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function scopeKey(scope: PromptOutboxScope | null): string | null {
  if (!scope || ![scope.person, scope.environment, scope.bootstrap].every(value => typeof value === "string" && value.trim())) return null;
  try {
    const bootstrap = new URL(scope.bootstrap);
    if (!["http:", "https:"].includes(bootstrap.protocol) || bootstrap.username || bootstrap.password || bootstrap.search || bootstrap.hash) return null;
    return JSON.stringify([scope.person, scope.environment, bootstrap.href]);
  } catch { return null; }
}
function validBody(value: unknown): value is PromptOutboxBody {
  return object(value) && typeof value.requestId === "string" && uuid.test(value.requestId)
    && typeof value.text === "string" && !!value.text.trim()
    && ["queue", "steer", "hardSteer"].includes(String(value.delivery))
    && (value.replyTo === undefined || typeof value.replyTo === "string" && !!value.replyTo)
    && (value.includeMeetingImages === undefined || typeof value.includeMeetingImages === "boolean")
    && Object.keys(value).every(key => ["requestId", "text", "delivery", "replyTo", "includeMeetingImages"].includes(key));
}
function validOutcome(value: unknown): value is PromptOutboxOutcome {
  if (!object(value)) return false;
  if (value.kind === "accepted") return typeof value.workId === "string" && !!value.workId && value.workId.length <= 512;
  if (value.kind === "rejected") return typeof value.message === "string" && !!value.message && value.message.length <= 512;
  return value.kind === "pending" && ["saved", "transport", "authentication", "unconfirmed"].includes(String(value.reason))
    && typeof value.message === "string" && value.message.length <= 512;
}
function validStored(value: unknown, scope: string): value is StoredEntry {
  if (!object(value) || value.scope !== scope || typeof value.requestId !== "string" || !uuid.test(value.requestId)
    || value.key !== `${scope}:${value.requestId}` || typeof value.sessionId !== "string" || !value.sessionId
    || typeof value.bodyJson !== "string" || typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)
    || !validOutcome(value.outcome)) return false;
  try {
    const body: unknown = JSON.parse(value.bodyJson);
    return validBody(body) && body.requestId === value.requestId;
  } catch { return false; }
}
function publicEntry(entry: StoredEntry): PromptOutboxEntry {
  return { requestId: entry.requestId, sessionId: entry.sessionId, bodyJson: entry.bodyJson,
    createdAt: entry.createdAt, outcome: { ...entry.outcome } };
}
function reservedBytes(entry: StoredEntry): number {
  return new TextEncoder().encode(JSON.stringify({ ...entry, outcome: null })).byteLength + RETAINED_MESSAGE_BYTES;
}
function classify(response: { status: number; body: unknown }, bodyJson: string): PromptOutboxOutcome {
  const { status, body } = response;
  if (status >= 200 && status < 300 && object(body) && body.accepted === true
    && typeof body.workId === "string" && !!body.workId && body.workId.length <= 512
    && body.delivery === JSON.parse(bodyJson).delivery) return { kind: "accepted", workId: body.workId };
  if (status >= 400 && status < 500 && object(body) && body.outcome === "rejected" && typeof body.error === "string" && !!body.error) {
    return { kind: "rejected", message: message(body.error) };
  }
  if ([401, 403, 423].includes(status)) return { kind: "pending", reason: "authentication", message: "Sign in to this person and environment to check acceptance." };
  return { kind: "pending", reason: "unconfirmed", message: object(body) && typeof body.error === "string" && body.error
    ? message(body.error) : `Acceptance is unconfirmed (HTTP ${status}). Check using the saved request.` };
}

/** Prompt intent only. Recovery requires an explicit submit; construction and list never replay work. */
export class PromptOutbox {
  private readonly scope: string | null;
  private readonly database: Promise<OutboxResult<IDBDatabase>>;
  private readonly inFlight = new Map<string, Promise<OutboxResult<PromptOutboxEntry>>>();
  private readonly controllers = new Set<AbortController>();
  private disposed = false;
  constructor(private options: {
    scope: PromptOutboxScope;
    currentScope: () => PromptOutboxScope | null;
    database: IDBFactory;
  }) {
    this.scope = scopeKey(options.scope);
    this.database = this.open();
  }
  private fence(): OutboxResult<string> {
    if (!this.scope) return bad("invalid_scope", "Prompt storage needs an explicit person, environment and bootstrap URL.");
    try {
      if (this.disposed || scopeKey(this.options.currentScope()) !== this.scope) return bad("scope_changed", "The prompt belongs to another person or environment.");
    } catch (error) { return bad("scope_changed", message(error)); }
    return good(this.scope);
  }
  private open(): Promise<OutboxResult<IDBDatabase>> {
    if (!this.scope) return Promise.resolve(bad("invalid_scope", "Prompt storage scope is invalid."));
    return new Promise(resolve => {
      let settled = false;
      const finish = (result: OutboxResult<IDBDatabase>) => { if (!settled) { settled = true; resolve(result); } };
      try {
        const request = this.options.database.open(DATABASE, 1);
        request.onupgradeneeded = () => {
          const store = request.result.createObjectStore(STORE, { keyPath: "key" });
          store.createIndex("scope", "scope", { unique: false });
        };
        request.onerror = () => finish(bad("storage_unavailable", message(request.error)));
        request.onblocked = () => finish(bad("storage_unavailable", "Close the other app tab to open prompt storage."));
        request.onsuccess = () => {
          if (settled || this.disposed) { request.result.close(); finish(bad("storage_unavailable", "Prompt storage was closed.")); return; }
          request.result.onversionchange = () => request.result.close();
          finish(good(request.result));
        };
      } catch (error) { finish(bad("storage_unavailable", message(error))); }
    });
  }
  private async transact<T>(mode: IDBTransactionMode, action: (entries: StoredEntry[], store: IDBObjectStore, scope: string) => OutboxResult<T>): Promise<OutboxResult<T>> {
    const fence = this.fence();
    if (!fence.ok) return fence;
    const opened = await this.database;
    if (!opened.ok) return opened;
    const current = this.fence();
    if (!current.ok) return current;
    return new Promise(resolve => {
      let result: OutboxResult<T> = bad("storage_unavailable", "Prompt storage did not complete.");
      try {
        const transaction = opened.value.transaction(STORE, mode, { durability: "strict" });
        const store = transaction.objectStore(STORE);
        transaction.oncomplete = () => { const current = this.fence(); resolve(current.ok ? result : current); };
        transaction.onabort = () => resolve(bad("storage_unavailable", message(transaction.error ?? "Prompt storage transaction aborted.")));
        const request = store.index("scope").getAll(fence.value);
        request.onsuccess = () => {
          const scoped = this.fence();
          if (!scoped.ok) { result = scoped; return; }
          const entries: unknown[] = request.result;
          if (entries.length > PROMPT_OUTBOX_LIMITS.entries || entries.some(entry => !validStored(entry, fence.value))) {
            result = bad("storage_corrupt", "Saved prompts are invalid; nothing was sent or deleted."); return;
          }
          try { result = action(entries as StoredEntry[], store, fence.value); }
          catch (error) {
            result = bad("storage_unavailable", message(error));
            transaction.abort();
          }
        };
      } catch (error) { resolve(bad("storage_unavailable", message(error))); }
    });
  }
  async list(): Promise<OutboxResult<PromptOutboxEntry[]>> {
    return this.transact("readonly", entries => good(entries.sort((a, b) => a.createdAt - b.createdAt).map(publicEntry)));
  }
  async enqueue(sessionId: string, body: PromptOutboxBody): Promise<OutboxResult<PromptOutboxEntry>> {
    let bodyJson: string;
    let requestId: string;
    try {
      if (typeof sessionId !== "string" || !sessionId.trim() || !validBody(body)) return bad("invalid_prompt", "Save a nonempty prompt with a stable requestId and explicit delivery mode.");
      bodyJson = JSON.stringify(body);
      const frozen: unknown = JSON.parse(bodyJson);
      if (!validBody(frozen)) return bad("invalid_prompt", "The serialized prompt is invalid.");
      requestId = frozen.requestId;
    } catch (error) { return bad("invalid_prompt", message(error)); }
    return this.transact("readwrite", (entries, store, scope) => {
      const previous = entries.find(entry => entry.requestId === requestId);
      if (previous) return previous.sessionId === sessionId && previous.bodyJson === bodyJson
        ? good(publicEntry(previous)) : bad("conflicting_request", "This requestId already belongs to another prompt. Its saved body was not changed.");
      const entry: StoredEntry = { key: `${scope}:${requestId}`, scope, requestId,
        sessionId, bodyJson, createdAt: Date.now(), outcome: { kind: "pending", reason: "saved", message: "Saved on this device; not yet acknowledged by the server." } };
      if (entries.length >= PROMPT_OUTBOX_LIMITS.entries || entries.reduce((total, item) => total + reservedBytes(item), reservedBytes(entry)) > PROMPT_OUTBOX_LIMITS.bytes) {
        return bad("full", "Saved prompt storage is full. Resolve or explicitly discard a saved prompt before sending another.");
      }
      store.add(entry);
      return good(publicEntry(entry));
    });
  }
  submit(requestId: string, transport: PromptOutboxTransport): Promise<OutboxResult<PromptOutboxEntry>> {
    const previous = this.inFlight.get(requestId);
    if (previous) return previous;
    const operation = this.deliver(requestId, transport).finally(() => this.inFlight.delete(requestId));
    this.inFlight.set(requestId, operation);
    return operation;
  }
  private async deliver(requestId: string, transport: PromptOutboxTransport): Promise<OutboxResult<PromptOutboxEntry>> {
    const loaded = await this.transact("readonly", entries => {
      const entry = entries.find(item => item.requestId === requestId);
      return entry ? good(publicEntry(entry)) : bad("not_found", "This saved prompt was not found.");
    });
    if (!loaded.ok || loaded.value.outcome.kind !== "pending") return loaded;
    const fence = this.fence();
    if (!fence.ok) return fence;
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(new Error("Prompt acknowledgement timed out.")), 20_000);
    let outcome: PromptOutboxOutcome;
    try {
      const response = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
        const abort = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", abort, { once: true });
        Promise.resolve().then(() => transport(loaded.value, controller.signal)).then(resolve, reject)
          .finally(() => controller.signal.removeEventListener("abort", abort));
      });
      outcome = classify(response, loaded.value.bodyJson);
    } catch (error) { outcome = { kind: "pending", reason: "transport", message: message(error) || "Acceptance is unconfirmed; check using the saved request." }; }
    finally { clearTimeout(timer); this.controllers.delete(controller); }
    return this.transact("readwrite", (entries, store) => {
      const entry = entries.find(item => item.requestId === requestId);
      if (!entry) return bad("not_found", "The saved prompt was explicitly discarded while checking acceptance.");
      if (entry.outcome.kind !== "pending") return good(publicEntry(entry));
      const next = { ...entry, outcome };
      store.put(next);
      return good(publicEntry(next));
    });
  }
  acknowledge(requestId: string): Promise<OutboxResult<void>> { return this.remove(requestId, false); }
  /** User abandonment only: the server may already have accepted this request. This does not Stop it. */
  discard(requestId: string): Promise<OutboxResult<void>> { return this.remove(requestId, true); }
  private remove(requestId: string, allowPending: boolean): Promise<OutboxResult<void>> {
    return this.transact("readwrite", (entries, store) => {
      const entry = entries.find(item => item.requestId === requestId);
      if (!entry) return bad("not_found", "This saved prompt was not found.");
      if (!allowPending && entry.outcome.kind === "pending") return bad("pending_not_acknowledged", "An unconfirmed prompt cannot be acknowledged as delivered.");
      store.delete(entry.key);
      return good(undefined);
    });
  }
  dispose(): void {
    this.disposed = true;
    for (const controller of this.controllers) controller.abort(new Error("Prompt owner changed."));
    void this.database.then(result => { if (result.ok) result.value.close(); });
  }
}
