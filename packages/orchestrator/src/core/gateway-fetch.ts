import { Agent, request as httpRequest } from "node:http";
import { createConnection, type Socket } from "node:net";
import { isAbsolute, resolve } from "node:path";
import { Readable } from "node:stream";
import { kernelPeer } from "./gateway-transport.js";

export type GatewayPeer = { socketPath: string; peerUid: number };
export async function unixGatewayFetch(peer: GatewayPeer, input: Request | URL | string, init?: RequestInit): Promise<Response> {
  if (!isAbsolute(peer.socketPath) || resolve(peer.socketPath) !== peer.socketPath || peer.socketPath.includes("\0") || !Number.isSafeInteger(peer.peerUid) || peer.peerUid < 0) throw new Error("Invalid registered Unix gateway peer");
  const request = input instanceof Request && init === undefined ? input : new Request(input, init);
  request.signal.throwIfAborted();
  const url = new URL(request.url);
  if (url.protocol !== "http:" || url.username || url.password) throw new Error("Unix gateways carry local HTTP only");
  const socket = createConnection(peer.socketPath);
  const abort = () => socket.destroy(request.signal.reason instanceof Error ? request.signal.reason : new Error("Gateway request aborted"));
  request.signal.addEventListener("abort", abort, { once: true });
  socket.once("close", () => request.signal.removeEventListener("abort", abort));
  // Keep socket errors observed while the peer helper owns only a duplicate fd.
  let socketError: Error | undefined;
  socket.on("error", error => { socketError = error; });
  try {
    await new Promise<void>((done, reject) => { socket.once("connect", done); socket.once("error", reject); });
    const verified = await kernelPeer(socket);
    if (!verified.ok || verified.value.uid !== peer.peerUid || socketError || socket.destroyed) throw socketError ?? new Error("Unix gateway server is not its configured kernel peer");
    request.signal.throwIfAborted();
    const agent = new Agent({ keepAlive: false });
    agent.createConnection = () => socket;
    return await new Promise<Response>((done, reject) => {
      const outgoing = httpRequest({ hostname: url.hostname, port: url.port || "80", path: url.pathname + url.search,
        method: request.method, headers: Object.fromEntries(request.headers), agent }, incoming => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) for (const item of value) headers.append(name, item);
          else if (value !== undefined) headers.set(name, value);
        }
        const noBody = request.method === "HEAD" || [101, 204, 205, 304].includes(incoming.statusCode!);
        done(new Response(noBody ? null : Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>, { status: incoming.statusCode!, statusText: incoming.statusMessage, headers }));
        if (noBody) incoming.resume();
      });
      outgoing.once("error", reject);
      if (request.body) {
        const body = Readable.fromWeb(request.body as unknown as import("node:stream/web").ReadableStream);
        body.once("error", error => outgoing.destroy(error));
        outgoing.once("close", () => body.destroy()); body.pipe(outgoing);
      } else outgoing.end();
    });
  } catch (cause) { socket.destroy(); throw cause; }
}
