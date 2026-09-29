const WEBSOCKET_BACKPRESSURE_LIMIT = 64 * 1024;
const WEBSOCKET_MAX_MESSAGE_BYTES = 1024 * 1024;

export type ProxySocketData = {
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
  maxPayloadLength: WEBSOCKET_MAX_MESSAGE_BYTES,
  backpressureLimit: WEBSOCKET_BACKPRESSURE_LIMIT,
  closeOnBackpressureLimit: false,
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
      if (socket.readyState !== WebSocket.OPEN || socket.getBufferedAmount() >= WEBSOCKET_BACKPRESSURE_LIMIT) return;
      const message = event.data;
      if (typeof message === "string" || message instanceof ArrayBuffer) socket.send(message, false);
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
    if (upstream.readyState !== WebSocket.OPEN || upstream.bufferedAmount >= WEBSOCKET_BACKPRESSURE_LIMIT) return;
    upstream.send(message);
  },
  close(socket, code, reason) {
    socket.data.closed = true;
    if (socket.data.abort) socket.data.signal.removeEventListener("abort", socket.data.abort);
    closeUpstream(socket.data.upstream, code, reason);
  },
} satisfies Bun.WebSocketHandler<ProxySocketData>;
