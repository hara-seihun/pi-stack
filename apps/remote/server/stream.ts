import type { StreamSnapshot, StreamSubscription, StreamWireEvent } from "./protocol";
import { ReconcilePublisher, readReconcileHave } from "../shared/reconcile";
import { historySourceChanged } from "../shared/history-source-retry";

export const PING_INTERVAL_MS = 10_000;
function optionalString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && value && value.length <= 256 ? value : undefined;
}

function optionalCursor(value: unknown): number | null | undefined {
  if (value === null) return null;
  const cursor = Number(value);
  return Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : undefined;
}

export function readSubscription(body: unknown): Partial<StreamSubscription> {
  const input = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const subscription: Partial<StreamSubscription> = {};
  if ("session" in input) {
    const session = optionalString(input.session);
    if (session !== undefined) subscription.session = session;
    else if (input.session === undefined) subscription.session = null;
  }
  const selectionId = optionalString(input.selectionId);
  if (selectionId) subscription.selectionId = selectionId;
  for (const flag of ["viewing", "thinking", "dashboard", "workers"] as const) {
    if (typeof input[flag] === "boolean") subscription[flag] = input[flag] as boolean;
  }
  for (const field of ["notificationsAfter", "eventsAfter", "transcriptFrom"] as const) {
    if (field in input) {
      const cursor = optionalCursor(input[field]);
      if (cursor !== undefined) subscription[field] = cursor;
    }
  }
  if ("have" in input) {
    const have = readReconcileHave(input.have);
    if (have) subscription.have = have;
  }
  if (Array.isArray(input.want) && input.want.length <= 128
    && input.want.every(value => typeof value === "string" && value.length > 0 && value.length <= 512)) {
    subscription.want = [...new Set(input.want)] as string[];
  }
  return subscription;
}

export function mergeSubscription(current: StreamSubscription, patch: Partial<StreamSubscription>): StreamSubscription {
  return { ...current, ...patch };
}

export interface StreamSink {
  write(chunk: string): void;
  close(): void;
}

export class ClientStream {
  readonly id = crypto.randomUUID();
  subscription: StreamSubscription = {};
  private readonly held = new Map<string, string>();
  private open = true;
  private change = 0;

  constructor(private readonly sink: StreamSink, private readonly publisher = new ReconcilePublisher()) {}

  get closed() { return !this.open; }
  get revision() { return this.change; }

  declare(patch: Partial<StreamSubscription>): void {
    this.subscription = mergeSubscription(this.subscription, patch);
    this.change++;
    if (patch.have !== undefined) {
      this.held.clear();
      for (const [resource, revision] of Object.entries(patch.have)) this.held.set(resource, revision);
    }
  }

  publish(snapshot: StreamSnapshot): void {
    if (this.closed) return;
    const resource = "sessionId" in snapshot ? `${snapshot.type}:${snapshot.sessionId}` : snapshot.type;
    if (this.subscription.want && !this.subscription.want.includes(resource)) return;
    if ("sessionId" in snapshot && snapshot.sessionId !== this.subscription.session) return;
    try { this.publisher.publish(resource, snapshot); }
    catch (cause) {
      if (!(cause instanceof RangeError)) throw cause;
      this.send({ type: "error", message: `Cannot synchronize ${resource}: ${cause.message}` });
      return;
    }
    const frame = this.publisher.reconcile(resource, this.held.get(resource) ?? null);
    if (frame && this.send({ type: "reconcile", ...frame })) this.held.set(resource, frame.revision);
  }

  async synchronizeSelection(refresh: () => Promise<void>, publish: () => void | Promise<void>): Promise<void> {
    const { session, selectionId } = this.subscription;
    if (!session) return;
    const current = () => !this.closed && this.subscription.session === session && this.subscription.selectionId === selectionId;
    try {
      for (let attempt = 0; ; attempt++) {
        if (!current()) return;
        try {
          await refresh();
          if (!current()) return;
          await publish();
          break;
        } catch (cause) {
          if (!historySourceChanged(cause) || attempt === 2) throw cause;
          await Promise.resolve();
        }
      }
      if (!current() || !selectionId) return;
      const resources = ["state", `transcript:${session}`, `live:${session}`];
      if (resources.some(resource => !this.held.has(resource))) return;
      this.send({ type: "selection-ready", sessionId: session, selectionId,
        have: Object.fromEntries(resources.map(resource => [resource, this.held.get(resource)!])) });
    } catch (cause) {
      if (current()) this.send({ type: "error", message: `Could not refresh thread: ${cause instanceof Error ? cause.message : String(cause)}` });
    }
  }

  send(event: StreamWireEvent): boolean {
    return this.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  ping(): void { this.write(": ping\n\n"); }

  close(): void {
    if (!this.open) return;
    this.open = false;
    try { this.sink.close(); } catch {}
  }

  private write(chunk: string): boolean {
    if (!this.open) return false;
    try { this.sink.write(chunk); return true; }
    catch { this.open = false; return false; }
  }
}
