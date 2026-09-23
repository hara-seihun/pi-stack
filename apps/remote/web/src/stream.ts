// One push stream per client. `POST /v1/stream` answers with
// `text/event-stream` and keeps sending until the connection dies; selection
// changes go up as small posts to `POST /v1/stream/:streamId`. There is no
// poll and no per-wake request: a token batch costs one frame.
//
// The client owns reconnection. A stream that has sent nothing for 30 seconds
// is dead even when the socket is still open (a sleeping phone, a proxy that
// dropped the body), so the watchdog aborts it and the backoff reconnects.

import { API } from "../../server/api";
import type { StreamEvent, StreamSubscription } from "../../server/protocol";
import { piFetch } from "./client";

export type StreamState = "connecting" | "open" | "offline";
export interface StreamStatus { state: StreamState; error: string }

export interface StreamFrame { event: string; data: string }

/** No bytes for this long means the stream is gone, comments included. */
export const DEAD_STREAM_MS = 30_000;
const MAX_RETRY_MS = 5_000;

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

/** A frame carries one JSON `StreamEvent`; `event:` names the variant. */
export function streamEventFromFrame(frame: StreamFrame): StreamEvent | null {
  if (!frame.data) return null;
  let value: any;
  try { value = JSON.parse(frame.data); } catch { return null; }
  if (!value || typeof value !== "object") return null;
  if (typeof value.type !== "string" && frame.event) value.type = frame.event;
  return typeof value.type === "string" ? value as StreamEvent : null;
}

const SESSION_SCOPED = new Set(["transcript", "live", "images", "events"]);

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
  state(): StreamState;
}

export interface StreamClientOptions {
  subscription: StreamSubscription;
  onEvent(event: StreamEvent): void;
  onStatus(status: StreamStatus): void;
  /** Voice and Meet bring their own authorized transport. */
  fetch?: (path: string, init: RequestInit) => Promise<Response>;
  /** Reconnect on `online`, `pageshow`, `focus` and visibility. */
  listen?: boolean;
  now?: () => number;
}

export function createStreamClient(options: StreamClientOptions): StreamClient {
  const send = options.fetch ?? ((path, init) => piFetch(path, init));
  let subscription: StreamSubscription = { ...options.subscription };
  let streamId = "";
  let stopped = true;
  let state: StreamState = "connecting";
  let controller: AbortController | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  let generation = 0;
  let posting: Promise<void> = Promise.resolve();

  const setStatus = (next: StreamState, error = "") => {
    state = next;
    options.onStatus({ state: next, error });
  };
  const clearWatchdog = () => { if (watchdog) clearTimeout(watchdog); watchdog = null; };
  const armWatchdog = (active: AbortController) => {
    clearWatchdog();
    watchdog = setTimeout(() => active.abort(new Error("The stream went silent")), DEAD_STREAM_MS);
  };

  const deliver = (event: StreamEvent) => {
    if (event.type === "hello") streamId = event.streamId;
    if (SESSION_SCOPED.has(event.type)) {
      const scoped = event as Extract<StreamEvent, { sessionId: string }>;
      if (scoped.sessionId !== subscription.session) return;
    }
    options.onEvent(event);
  };

  async function connect(mine: number) {
    const active = new AbortController();
    controller = active;
    streamId = "";
    setStatus("connecting");
    const response = await send(API.stream.path(), {
      method: "POST",
      headers: { accept: "text/event-stream", "content-type": "application/json" },
      body: JSON.stringify(subscription),
      signal: active.signal,
      cache: "no-store",
    });
    if (mine !== generation || stopped) return;
    if (!response.ok) throw new Error(`The stream returned HTTP ${response.status}`);
    if (!response.body) throw new Error("The stream returned no body");
    failures = 0;
    setStatus("open");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = new EventStreamParser();
    armWatchdog(active);
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (mine !== generation || stopped) return;
        if (done) throw new Error("The stream closed");
        armWatchdog(active);
        for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
          const event = streamEventFromFrame(frame);
          if (event) deliver(event);
        }
      }
    } finally {
      clearWatchdog();
      reader.cancel().catch(() => {});
    }
  }

  const schedule = (delay: number) => {
    if (stopped || retry) return;
    retry = setTimeout(() => { retry = null; open(); }, delay);
  };

  function open() {
    if (stopped) return;
    if (retry) { clearTimeout(retry); retry = null; }
    controller?.abort();
    const mine = ++generation;
    void connect(mine).then(
      () => {}, // Returns only when a newer connection replaced this one or the client stopped.
      (error: unknown) => {
        if (mine !== generation || stopped) return;
        const message = error instanceof Error ? error.message : String(error);
        setStatus("offline", message);
        schedule(Math.min(MAX_RETRY_MS, 1_000 * 2 ** Math.min(failures++, 3)));
      },
    );
  }

  function post(change: Partial<StreamSubscription>) {
    const id = streamId;
    if (!id) return;
    posting = posting.then(async () => {
      if (stopped || streamId !== id) return;
      try {
        const response = await send(API.streamUpdate.path({ streamId: id }), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(change),
          cache: "no-store",
        });
        if (response.status === 404) { open(); return; }
        if (!response.ok) throw new Error(`The stream rejected the change with HTTP ${response.status}`);
      } catch (error) {
        if (stopped || streamId !== id) return;
        setStatus("offline", error instanceof Error ? error.message : String(error));
        open();
      }
    });
  }

  const wake = () => { if (!stopped && state !== "open") open(); };
  const visible = () => { if (document.visibilityState === "visible") wake(); };
  const listen = options.listen ?? true;

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      failures = 0;
      if (listen) {
        window.addEventListener("online", wake);
        window.addEventListener("pageshow", wake);
        window.addEventListener("focus", wake);
        document.addEventListener("visibilitychange", visible);
      }
      open();
    },
    stop() {
      stopped = true;
      generation++;
      controller?.abort();
      controller = null;
      clearWatchdog();
      if (retry) clearTimeout(retry);
      retry = null;
      streamId = "";
      if (listen) {
        window.removeEventListener("online", wake);
        window.removeEventListener("pageshow", wake);
        window.removeEventListener("focus", wake);
        document.removeEventListener("visibilitychange", visible);
      }
    },
    update(change) {
      subscription = { ...subscription, ...change };
      if (stopped) return;
      if (streamId) post(change);
      else open();
    },
    remember(change) { subscription = { ...subscription, ...change }; },
    reconnect() { failures = 0; open(); },
    subscription: () => ({ ...subscription }),
    state: () => state,
  };
}
