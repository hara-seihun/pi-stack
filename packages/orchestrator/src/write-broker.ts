import type { Server, IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import WebSocket, { WebSocketServer, type RawData } from "ws";

/** A broker listener is UID-gated by the host. Only its person's supervisor
 * can reach this route; no caller chooses an upstream URL or another owner. */
export function attachWriteBroker(server: Server, shutdown: AbortSignal, reserve: () => boolean, release: () => void) {
  const sockets = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1024 * 1024 });
  const active = new Set<WebSocket>();
  const close = () => { for (const socket of active) socket.close(1012, "Broker stopping"); sockets.close(); };
  shutdown.addEventListener("abort", close, { once: true });
  server.on("upgrade", (request: IncomingMessage, socket: Socket, head: Buffer) => {
    if (request.url !== "/v1/write/stream" || !reserve() || shutdown.aborted) { socket.destroy(); return; }
    try {
      sockets.handleUpgrade(request, socket, head, client => {
        active.add(client);
        const engine = new WebSocket(process.env.PI_STACK_WRITE_URL ?? "ws://127.0.0.1:8797/", { perMessageDeflate: false, maxPayload: 1024 * 1024 });
        active.add(engine);
        const queued: Array<{ data: RawData | string; binary: boolean }> = [];
        let bytes = 0;
        let closed = false;
        const finish = () => {
          if (closed) return;
          closed = true;
          active.delete(client); active.delete(engine); release();
          if (client.readyState === WebSocket.OPEN) client.close();
          if (engine.readyState === WebSocket.OPEN) engine.send(JSON.stringify({ type: "cancel" }));
          engine.close();
        };
        engine.on("open", () => { for (const frame of queued) engine.send(frame.data, { binary: frame.binary }); queued.length = 0; bytes = 0; });
        engine.on("message", (frame, binary) => {
          if (client.readyState === WebSocket.OPEN && client.bufferedAmount < 64 * 1024) client.send(frame, { binary });
          else finish();
        });
        client.on("message", (frame, binary) => {
          const size = Array.isArray(frame) ? frame.reduce((sum, chunk) => sum + chunk.byteLength, 0) : frame.byteLength;
          if (engine.readyState === WebSocket.OPEN && engine.bufferedAmount < 64 * 1024) engine.send(frame, { binary });
          else if (engine.readyState === WebSocket.CONNECTING && bytes + size < 64 * 1024) { queued.push({ data: frame, binary }); bytes += size; }
          else finish();
        });
        engine.on("error", finish); client.on("error", finish);
        engine.on("close", finish); client.on("close", finish);
      });
    } catch { release(); socket.destroy(); }
  });
}
