import { gatewayRequest } from "../core/gateway-request.js";
import { unixGatewayFetch } from "../core/gateway-fetch.js";
import { createThreadClient, ThreadTransportError, type ThreadClientOptions } from "./http.js";

export function createGatewayThreadClient(baseUrl: string, env: Record<string, string | undefined>, options: ThreadClientOptions = {}) {
  return createThreadClient(baseUrl, async (endpoint, init) => {
    const route = new URL(String(endpoint)), headers = new Headers(init?.headers);
    const nativeHeaders = Object.fromEntries(["x-pi-thread-token", "x-pi-thread-deadline"].flatMap(name => { const value = headers.get(name); return value === null ? [] : [[name, value]]; }));
    const receipt = await gatewayRequest({ method: init?.method ?? "GET", route: route.pathname + route.search,
      ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }), ...(Object.keys(nativeHeaders).length ? { headers: nativeHeaders } : {}) }, env,
      (peer, input, gatewayInit) => unixGatewayFetch(peer, input, { ...gatewayInit, signal: init?.signal ? AbortSignal.any([init.signal, gatewayInit!.signal!]) : gatewayInit?.signal }));
    if (!receipt.ok) throw new ThreadTransportError(`${receipt.error.code}: ${receipt.error.message}`, receipt.error.code === "transport-unconfirmed" ? "unconfirmed" : "not-contacted");
    return new Response(JSON.stringify(receipt.value.body), { status: receipt.value.status, headers: { "content-type": "application/json" } });
  }, { ...options, token: env.PI_THREAD_TOKEN });
}
