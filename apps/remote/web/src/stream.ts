// A retained replica reconciles through a finite request. Push is a disposable
// accelerator: no stream identity is needed to select, refresh or recover state.
// A generation fences the two transports so a late response cannot rewind it.

import { API } from "../../server/api";
import type { StreamEvent, StreamSnapshot, StreamSubscription, StreamWireEvent } from "../../server/protocol";
import { ReconcileReplica, revisionOf } from "../../shared/reconcile";
import { isStreamSnapshot, streamResource, streamWants } from "../../shared/stream-resources";
import { piFetch } from "./client";
import { abortable } from "./abortable";
import { assertNever, requireState } from "../../shared/explicit-state";
import { stateObject, stateString, stateArray, validateBootstrap, validateStreamSnapshot } from "../../shared/state-validation";

export type StreamState = "connecting" | "open" | "offline";
export interface StreamStatus { state: StreamState; error: string; diagnostic?: string }

export interface StreamFrame { event: string; data: string }

/** No bytes for this long means the stream is gone, comments included. */
export const DEAD_STREAM_MS = 30_000;
const MAX_RETRY_MS = 5_000;
export const RECONCILE_TIMEOUT_MS = 5_000;
export const RECONNECT_GRACE_MS = 5_000;

class StreamHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function authenticationMessage(error: unknown): string {
  if (!(error instanceof StreamHttpError)) return "";
  if (error.status === 423) return "Unlock your folder to reconnect.";
  if (error.status === 401 || error.status === 403) return "Sign in to reconnect.";
  return "";
}

/** Incremental `text/event-stream` reader. Comment lines are keep-alives. */
export class EventStreamParser {
  private buffer = "";
  private event = "";
  private data: string[] = [];

  push(chunk: string): StreamFrame[] {
    this.buffer += chunk;
    const frames: StreamFrame[] = [];
    for (;;) {
      const end = this.buffer.search(/\r\n|\n|\r/);
      if (end < 0) break;
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + (this.buffer.startsWith("\r\n", end) ? 2 : 1));
      const frame = this.line(line);
      if (frame) frames.push(frame);
    }
    return frames;
  }

  private line(line: string): StreamFrame | null {
    if (line === "") {
      if (!this.data.length && !this.event) return null;
      const frame = { event: this.event || "message", data: this.data.join("\n") };
      this.event = "";
      this.data = [];
      return frame;
    }
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.event = value;
    else if (field === "data") this.data.push(value);
    return null;
  }
}

export class StreamProtocolError extends Error {}

/** Invalid wire input never becomes a healthy event or a silent no-op. */
export function streamEventFromFrame(frame: StreamFrame): StreamWireEvent | null {
  if (!frame.data && !frame.event) return null;
  try {
    const value = stateObject(JSON.parse(frame.data), "Stream event");
    if (!Object.hasOwn(value, "type") && frame.event) value.type = frame.event;
    const type = requireState(value.type, { hello: true, reconcile: true, "selection-ready": true, notifications: true, events: true, error: true } satisfies Record<StreamWireEvent["type"], true>, "Stream event type");
    switch (type) {
      case "hello": stateString(value.epoch, "Supervisor epoch"); stateString(value.streamId, "Stream id"); validateBootstrap(value.bootstrap); break;
      case "reconcile":
        stateString(value.resource, "Reconcile resource"); stateString(value.revision, "Reconcile revision");
        requireState(value.kind, { full: true, patch: true }, "Reconcile kind");
        break;
      case "selection-ready": stateString(value.sessionId, "Selected session"); stateString(value.selectionId, "Selection id"); stateObject(value.have, "Selection revisions"); break;
      case "notifications": stateArray(stateObject(value.feed, "Notification feed").notifications, "Notifications"); break;
      case "events": stateString(value.sessionId, "Event session"); stateArray(value.events, "Session events"); break;
      case "error": stateString(value.message, "Stream error"); break;
    }
    return value as unknown as StreamWireEvent;
  } catch (error) {
    throw new StreamProtocolError(`Invalid stream input: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export interface StreamClient {
  start(): void;
  stop(): void;
  /** Change the subscription and tell the server now. */
  update(change: Partial<StreamSubscription>): void;
  /** Change what the next connection will ask for without a request. */
  remember(change: Partial<StreamSubscription>): void;
  /** Drop the current connection and subscribe again immediately. */
  reconnect(): void;
  subscription(): StreamSubscription;
  invalidate(resource: string): void;
  /** Seed a resource from an actual memory or disk snapshot, not a guessed server revision. */
  restore(snapshot: StreamSnapshot): void;
  state(): StreamState;
}

export interface StreamClientOptions {
  subscription: StreamSubscription;
  onEvent(event: StreamEvent): void;
  onStatus(status: StreamStatus): void;
  onSelectionStatus?(status: { sessionId: string | null; ready: boolean }): void;
  /** Voice and Meet bring their own authorized transport. */
  fetch?: (path: string, init: RequestInit) => Promise<Response>;
  /** Reconnect on `online`, `pageshow`, `focus` and visibility. */
  listen?: boolean;
  now?: () => number;
  /** Ordinary app feeds sleep when hidden; intentional Voice/Meet feeds do not. */
  suspendWhenHidden?: boolean;
  beforeReconcile?(): Promise<Partial<StreamSubscription>>;
  onActivity?(healthy: boolean): void;
}

export function createStreamClient(options: StreamClientOptions): StreamClient {
  const send = options.fetch ?? ((path, init) => piFetch(path, init));
  let subscription: StreamSubscription = { ...options.subscription };
  const replica = new ReconcileReplica();
  let stopped = true;
  let state: StreamState = "connecting";
  let controller: AbortController | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  let recovering = false;
  let recoveryOverdue = false;
  let diagnostic = "";
  let authenticationError = "";
  let failures = 0;
  let generation = 0;
  let pushFailures = 0;
  let acknowledged = false;
  const runnable = () => !stopped && (!options.suspendWhenHidden || document.visibilityState === "visible");
  const declaration = (): StreamSubscription => {
    const want = streamWants(subscription);
    const resident = replica.have();
    const have = Object.fromEntries(want.filter(resource => resource in resident).map(resource => [resource, resident[resource]]));
    return { ...subscription, have, want };
  };

  const beginSelection = () => {
    acknowledged = false;
    subscription = { ...subscription, selectionId: crypto.randomUUID() };
    options.onSelectionStatus?.({ sessionId: subscription.session ?? null, ready: false });
  };

  const setStatus = (next: StreamState, error = "") => {
    state = next;
    options.onStatus({ state: next, error, ...(diagnostic ? { diagnostic } : {}) });
  };
  const showRecovery = () => setStatus(
    authenticationError || recoveryOverdue ? "offline" : "connecting",
    authenticationError || (recoveryOverdue ? "Connection lost. Reconnecting…" : ""),
  );
  const beginRecovery = () => {
    if (!recovering) {
      recovering = true;
      recoveryTimer = setTimeout(() => {
        recoveryTimer = null;
        recoveryOverdue = true;
        showRecovery();
      }, RECONNECT_GRACE_MS);
    }
    showRecovery();
  };
  const clearRecovery = () => {
    if (recoveryTimer) clearTimeout(recoveryTimer);
    recoveryTimer = null;
    recovering = false;
    recoveryOverdue = false;
    diagnostic = "";
    authenticationError = "";
  };
  const recovered = () => {
    acknowledged = true;
    failures = 0;
    clearRecovery();
    setStatus("open");
  };
  const failed = (error: unknown) => {
    diagnostic = error instanceof Error ? error.message : String(error);
    authenticationError = authenticationMessage(error) || authenticationError;
    options.onSelectionStatus?.({ sessionId: subscription.session ?? null, ready: false });
    if (error instanceof StreamProtocolError) {
      authenticationError = error.message;
      showRecovery();
    } else beginRecovery();
  };
  const clearWatchdog = () => { if (watchdog) clearTimeout(watchdog); watchdog = null; };
  const armWatchdog = (active: AbortController) => {
    clearWatchdog();
    watchdog = setTimeout(() => active.abort(new Error("The stream went silent")), DEAD_STREAM_MS);
  };

  const deliver = (event: StreamWireEvent) => {
    if (event.type === "hello") {
      if (!subscription.session || !subscription.viewing) recovered();
      options.onEvent(event);
      return;
    }
    if (event.type === "selection-ready") {
      if (event.sessionId !== subscription.session || event.selectionId !== subscription.selectionId) return;
      const have = replica.have();
      if (["state", `transcript:${event.sessionId}`, `live:${event.sessionId}`].some(resource => !event.have[resource] || have[resource] !== event.have[resource])) return;
      recovered();
      options.onSelectionStatus?.({ sessionId: event.sessionId, ready: true });
      return;
    }
    if (event.type === "reconcile") {
      if (!streamWants(subscription).includes(event.resource)) return;
      if (/^(transcript|live|images|questions):/.test(event.resource) && event.resource.slice(event.resource.indexOf(":") + 1) !== subscription.session) return;
      const result = replica.apply(event);
      if (!result.ok) {
        if (result.reason !== "Base revision mismatch") throw new StreamProtocolError(`Invalid ${event.resource} frame: ${result.reason}`);
        replica.forget(event.resource);
        throw new StreamProtocolError(`Lost base for ${event.resource}; requesting retained state again`);
      }
      try { validateStreamSnapshot(event.resource, result.value); }
      catch (error) {
        replica.forget(event.resource);
        throw new StreamProtocolError(`Invalid ${event.resource} snapshot: ${error instanceof Error ? error.message : String(error)}`);
      }
      options.onEvent(result.value);
      return;
    }
    switch (event.type) {
      case "events":
        if (event.sessionId !== subscription.session) return;
        options.onEvent(event); return;
      case "notifications": case "error": options.onEvent(event); return;
    }
    assertNever(event, "Stream delivery");
  };

  async function connect(mine: number) {
    const active = new AbortController();
    controller = active;
    beginSelection();
    beginRecovery();
    const deadline = setTimeout(() => active.abort(new Error("State synchronization timed out")), RECONCILE_TIMEOUT_MS);
    try {
      if (options.beforeReconcile) {
        const patch = await abortable(options.beforeReconcile(), active.signal);
        if (mine !== generation || !runnable()) return;
        subscription = { ...subscription, ...patch };
      }
      const response = await abortable(send(API.reconcile.path(), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(declaration()), signal: active.signal, cache: "no-store",
      }), active.signal);
      if (mine !== generation || !runnable()) return;
      if (!response.ok) throw new StreamHttpError(response.status, `State synchronization returned HTTP ${response.status}`);
      let events: unknown[];
      try {
        const result = stateObject(await abortable(response.json(), active.signal), "Reconciliation response");
        events = stateArray(result.events, "Reconciliation events");
      } catch (error) {
        if (active.signal.aborted) throw active.signal.reason;
        throw new StreamProtocolError(`Invalid reconciliation response: ${error instanceof Error ? error.message : String(error)}`);
      }
      for (const value of events) {
        if (mine !== generation || !runnable()) return;
        const event = streamEventFromFrame({ event: "", data: JSON.stringify(value) });
        if (event) deliver(event);
        if (event?.type === "error") throw new StreamProtocolError(event.message);
      }
      if (!acknowledged) throw new StreamProtocolError("State synchronization did not acknowledge this selection");
      options.onActivity?.(true);
    } finally { clearTimeout(deadline); }
    if (mine !== generation || !runnable()) return;
    const connectedAt = (options.now ?? Date.now)();
    const openingDeadline = setTimeout(() => active.abort(new Error("Push opening timed out")), RECONCILE_TIMEOUT_MS);
    try {
    const response = await abortable(send(API.stream.path(), {
      method: "POST",
      headers: { accept: "text/event-stream", "content-type": "application/json" },
      body: JSON.stringify(declaration()),
      signal: active.signal,
      cache: "no-store",
    }), active.signal);
    clearTimeout(openingDeadline);
    if (mine !== generation || !runnable()) return;
    if (!response.ok) throw new StreamHttpError(response.status, `The stream returned HTTP ${response.status}`);
    if (!response.body) throw new Error("The stream returned no body");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = new EventStreamParser();
    armWatchdog(active);
    try {
      for (;;) {
        const { value, done } = await abortable(reader.read(), active.signal);
        if (mine !== generation || !runnable()) return;
        if (done) throw new Error("The stream closed");
        if ((options.now ?? Date.now)() - connectedAt >= 10_000) pushFailures = 0;
        armWatchdog(active);
        for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
          if (mine !== generation || stopped) return;
          const event = streamEventFromFrame(frame);
          if (event) deliver(event);
        }
        options.onActivity?.(true);
      }
    } finally {
      if (mine === generation) clearWatchdog();
      reader.cancel().catch(() => {});
    }
    } catch (error) {
      if (mine !== generation || !runnable()) return;
      options.onActivity?.(false);
      if (error instanceof StreamProtocolError || authenticationMessage(error)) throw error;
      // The replica was reconciled independently. A push failure does not undo it.
      schedule(pushFailures++ === 0 ? 0 : Math.min(MAX_RETRY_MS, 250 * 2 ** Math.min(pushFailures, 5)));
    } finally { clearTimeout(openingDeadline); }
  }

  const schedule = (delay: number) => {
    if (!runnable() || retry) return;
    retry = setTimeout(() => { retry = null; open(); }, delay);
  };

  function open() {
    if (!runnable()) return;
    if (retry) { clearTimeout(retry); retry = null; }
    controller?.abort();
    clearWatchdog();
    options.onActivity?.(false);
    const mine = ++generation;
    void connect(mine).then(
      () => {}, // Returns only when a newer connection replaced this one or the client stopped.
      (error: unknown) => {
        if (mine !== generation || stopped) return;
        clearWatchdog();
        failed(controller?.signal.aborted ? controller.signal.reason : error);
        schedule(failures++ === 0 ? 0 : Math.min(MAX_RETRY_MS, 250 * 2 ** Math.min(failures, 5)));
      },
    );
  }

  function suspend() {
    generation++;
    controller?.abort();
    controller = null;
    clearWatchdog();
    clearRecovery();
    if (retry) clearTimeout(retry);
    retry = null;
    options.onActivity?.(false);
  }
  let wakeQueued = false;
  const wake = () => {
    if (!runnable() || wakeQueued) return;
    wakeQueued = true;
    queueMicrotask(() => { wakeQueued = false; if (runnable()) { failures = 0; pushFailures = 0; open(); } });
  };
  const visible = () => {
    if (document.visibilityState === "visible") wake();
    else if (options.suspendWhenHidden) suspend();
  };
  const listen = options.listen ?? true;

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      failures = 0;
      if (listen) {
        window.addEventListener("online", wake);
        window.addEventListener("pi-network-changed", wake);
        window.addEventListener("pageshow", wake);
        window.addEventListener("focus", wake);
        document.addEventListener("visibilitychange", visible);
      }
      open();
    },
    stop() {
      stopped = true;
      suspend();
      if (listen) {
        window.removeEventListener("online", wake);
        window.removeEventListener("pi-network-changed", wake);
        window.removeEventListener("pageshow", wake);
        window.removeEventListener("focus", wake);
        document.removeEventListener("visibilitychange", visible);
      }
    },
    update(change) {
      const previous = streamWants(subscription);
      if (Object.entries(change).every(([key, value]) => subscription[key as keyof StreamSubscription] === value)) return;
      subscription = { ...subscription, ...change };
      if (stopped) return;
      for (const resource of streamWants(subscription)) {
        if (previous.includes(resource)) continue;
        const held = replica.get(resource);
        if (held && isStreamSnapshot(resource, held.value)) options.onEvent(held.value);
      }
      open();
    },
    remember(change) { subscription = { ...subscription, ...change }; },
    reconnect() { failures = 0; pushFailures = 0; open(); },
    subscription: () => ({ ...subscription }),
    invalidate(resource) {
      replica.forget(resource);
      open();
    },
    restore(snapshot) {
      const resource = streamResource(snapshot);
      validateStreamSnapshot(resource, snapshot);
      if (replica.get(resource)) return;
      replica.seed(resource, revisionOf(snapshot), snapshot);
      if (streamWants(subscription).includes(resource)) open();
    },
    state: () => state,
  };
}
