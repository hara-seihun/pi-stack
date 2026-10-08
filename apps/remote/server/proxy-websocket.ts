import { PHONE_MAX_FRAME_BYTES } from "./phone-commands";

const WEBSOCKET_BACKPRESSURE_LIMIT = 64 * 1024;

export type ProxySocketData = {
  phone: boolean;
  lossless?: boolean;
  signal: AbortSignal;
  upstream: WebSocket;
  abort?: () => void;
  closed: boolean;
};

function canSendCloseCode(code: number): boolean {
  return (code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code <= 4999);
}

function closeBrowser(socket: Bun.ServerWebSocket<ProxySocketData>, code: number, reason: string): void {
  if (socket.readyState >= WebSocket.CLOSING) return;
  if (canSendCloseCode(code)) socket.close(code, reason);
  else socket.terminate();
}

function closeUpstream(socket: WebSocket | undefined, code: number, reason: string): void {
  if (!socket || socket.readyState >= WebSocket.CLOSING) return;
  if (canSendCloseCode(code)) socket.close(code, reason);
  else (socket as WebSocket & { terminate(): void }).terminate();
}

export const proxyWebsocket = {
  perMessageDeflate: false,
  maxPayloadLength: PHONE_MAX_FRAME_BYTES,
  backpressureLimit: PHONE_MAX_FRAME_BYTES,
  closeOnBackpressureLimit: false,
  idleTimeout: 45,
  sendPings: true,
  open(socket) {
    const { upstream, signal } = socket.data;
    if (signal.aborted) {
      closeUpstream(upstream, 1008, "Session ended");
      closeBrowser(socket, 1008, "Session ended");
      return;
    }
    const abort = () => {
      closeUpstream(upstream, 1008, "Session ended");
      closeBrowser(socket, 1008, "Session ended");
    };
    socket.data.abort = abort;
    signal.addEventListener("abort", abort, { once: true });
    upstream.addEventListener("message", (event) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      const limit = socket.data.phone || socket.data.lossless ? PHONE_MAX_FRAME_BYTES : WEBSOCKET_BACKPRESSURE_LIMIT;
      if (socket.getBufferedAmount() >= limit) {
        if (socket.data.phone || socket.data.lossless) {
          closeUpstream(upstream, 1011, "Proxy backpressure exceeded");
          closeBrowser(socket, 1011, "Proxy backpressure exceeded");
        }
        return;
      }
      const message = event.data;
      if (typeof message === "string" || message instanceof ArrayBuffer) {
        const sent = socket.send(message, false);
        if (sent === 0 && (socket.data.phone || socket.data.lossless)) {
          closeUpstream(upstream, 1011, "Proxy forwarding failed");
          closeBrowser(socket, 1011, "Proxy forwarding failed");
        }
      }
    });
    upstream.addEventListener("close", (event) => {
      socket.data.closed = true;
      signal.removeEventListener("abort", abort);
      closeBrowser(socket, event.code, event.reason);
    });
    upstream.addEventListener("error", () => {
      if (!socket.data.closed) closeBrowser(socket, 1011, "Upstream WebSocket failed");
    });
  },
  message(socket, message) {
    const upstream = socket.data.upstream;
    if (upstream.readyState !== WebSocket.OPEN) return;
    const limit = socket.data.phone || socket.data.lossless ? PHONE_MAX_FRAME_BYTES : WEBSOCKET_BACKPRESSURE_LIMIT;
    if (upstream.bufferedAmount >= limit) {
      if (socket.data.phone || socket.data.lossless) {
        closeUpstream(upstream, 1011, "Proxy backpressure exceeded");
        closeBrowser(socket, 1011, "Proxy backpressure exceeded");
      }
      return;
    }
    upstream.send(message);
  },
  close(socket, code, reason) {
    socket.data.closed = true;
    if (socket.data.abort) socket.data.signal.removeEventListener("abort", socket.data.abort);
    closeUpstream(socket.data.upstream, code, reason);
  },
} satisfies Bun.WebSocketHandler<ProxySocketData>;
