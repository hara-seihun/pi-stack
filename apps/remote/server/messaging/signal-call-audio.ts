import { createConnection, type Socket } from "node:net";
import type { BackendCallAudio } from "./plugin";
import type { MessagingResult } from "./protocol";

export const CALL_AUDIO_FRAME_BYTES = 1_920;
const TUNNEL_FRAME_BYTES = 960;
const CONNECT_WINDOW_MS = 1_000;
const CONNECT_ATTEMPT_MS = 150;
const RETRY_DELAY_MS = 25;

const failure = (message: string): MessagingResult<never> => ({ ok: false, error: { code: "call_audio", message } });
const delay = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));
const detail = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

type ConnectResult = { ok: true; socket: Socket } | { ok: false; error: string };

function connectOnce(path: string, timeoutMs: number): Promise<ConnectResult> {
  return new Promise(resolve => {
    const socket = createConnection(path);
    let settled = false;
    const finish = (result: ConnectResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("connect", connected);
      socket.off("error", failed);
      if (!result.ok) socket.destroy();
      resolve(result);
    };
    const connected = () => finish({ ok: true, socket });
    const failed = (cause: Error) => finish({ ok: false, error: detail(cause) });
    const timer = setTimeout(() => finish({ ok: false, error: "connection timed out" }), timeoutMs);
    socket.once("connect", connected);
    socket.once("error", failed);
  });
}

async function connectWithin(path: string): Promise<ConnectResult> {
  const deadline = Date.now() + CONNECT_WINDOW_MS;
  let lastError = "connection failed";
  while (Date.now() < deadline) {
    const result = await connectOnce(path, Math.min(CONNECT_ATTEMPT_MS, Math.max(1, deadline - Date.now())));
    if (result.ok) return result;
    lastError = result.error;
    if (Date.now() < deadline) await delay(Math.min(RETRY_DELAY_MS, deadline - Date.now()));
  }
  return { ok: false, error: lastError };
}

class SignalCallAudio implements BackendCallAudio {
  private socket?: Socket;
  private remote: (frame: Uint8Array) => void = () => {};
  private pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private closed = false;
  private recovering = false;
  private recovered = false;
  private failureReported = false;

  private constructor(private readonly path: string, private readonly onFailure: (message: string) => void) {}

  static async open(path: string, onFailure: (message: string) => void): Promise<MessagingResult<SignalCallAudio>> {
    const connection = await connectWithin(path);
    if (!connection.ok) return failure(`Signal call audio could not connect to ${path}: ${connection.error}`);
    const audio = new SignalCallAudio(path, onFailure);
    audio.bind(connection.socket);
    return { ok: true, value: audio };
  }

  onRemote(handler: (frame: Uint8Array) => void): void {
    this.remote = handler;
  }

  write(frame: Uint8Array): void {
    const socket = this.socket;
    if (this.closed || !socket || frame.byteLength !== CALL_AUDIO_FRAME_BYTES || socket.destroyed) return;
    if (socket.writableLength > CALL_AUDIO_FRAME_BYTES * 4) return;
    for (let offset = 0; offset < frame.byteLength; offset += TUNNEL_FRAME_BYTES) {
      socket.write(frame.subarray(offset, offset + TUNNEL_FRAME_BYTES));
    }
  }

  private bind(socket: Socket): void {
    if (this.closed) { socket.destroy(); return; }
    this.socket = socket;
    socket.on("data", chunk => this.read(typeof chunk === "string" ? Buffer.from(chunk) : chunk));
    socket.once("error", cause => this.disconnected(socket, detail(cause)));
    socket.once("end", () => this.disconnected(socket, "socket ended"));
    socket.once("close", () => this.disconnected(socket, "socket closed"));
  }

  private read(chunk: Buffer): void {
    this.pending = this.pending.byteLength ? Buffer.concat([this.pending, chunk]) : chunk;
    while (this.pending.byteLength >= CALL_AUDIO_FRAME_BYTES) {
      const frame = this.pending.subarray(0, CALL_AUDIO_FRAME_BYTES);
      this.pending = this.pending.subarray(CALL_AUDIO_FRAME_BYTES);
      this.remote(new Uint8Array(frame));
    }
  }

  private disconnected(socket: Socket, reason: string): void {
    if (this.closed || this.socket !== socket) return;
    this.socket = undefined;
    this.pending = Buffer.alloc(0);
    socket.destroy();
    if (!this.recovered && !this.recovering) {
      this.recovered = true;
      this.recovering = true;
      void connectWithin(this.path).then(result => {
        this.recovering = false;
        if (this.closed) {
          if (result.ok) result.socket.destroy();
          return;
        }
        if (result.ok) this.bind(result.socket);
        else this.reportFailure(`${reason}; reconnect failed: ${result.error}`);
      });
      return;
    }
    this.reportFailure(reason);
  }

  private reportFailure(reason: string): void {
    if (this.failureReported || this.closed) return;
    this.failureReported = true;
    this.onFailure(`Signal call audio failed: ${reason}`);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.pending = Buffer.alloc(0);
    const socket = this.socket;
    this.socket = undefined;
    socket?.destroy();
  }
}

export async function openSignalCallAudio(
  inputDeviceName: string,
  outputDeviceName: string,
  onFailure: (message: string) => void,
): Promise<MessagingResult<BackendCallAudio>> {
  if (!inputDeviceName.startsWith("unix:") || !outputDeviceName.startsWith("unix:")) {
    return failure("Signal call audio requires the tunnel's pipe mode, but signal-cli reported a host audio device");
  }
  if (inputDeviceName !== outputDeviceName) {
    return failure("Signal call audio reported different input and output sockets");
  }
  const path = inputDeviceName.slice("unix:".length);
  if (!path) return failure("Signal call audio reported an empty Unix socket path");
  return SignalCallAudio.open(path, onFailure);
}
