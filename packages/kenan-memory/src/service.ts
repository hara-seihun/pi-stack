import { createServer, type IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { MEMORY_TOKEN_HEADER, type MemoryRequest, type MemoryResult, type MemoryValue } from "./contract.js";
import { MemoryStore } from "./store.js";
import { validateRequest } from "./validation.js";
export interface MemoryAuth { supervisors: { person: string; token: string }[]; publisherToken?: string; uidPersons?: Record<string, string> }
type Principal = { kind: "person"; person: string; threadId?: string } | { kind: "publisher" };
const equal = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
export function loopbackUid(request: IncomingMessage): number | undefined {
  const socket = request.socket;
  if (socket.remoteAddress !== "127.0.0.1" || socket.localAddress !== "127.0.0.1" || !socket.remotePort || !socket.localPort) return;
  const client = `0100007F:${socket.remotePort.toString(16).toUpperCase().padStart(4, "0")}`;
  const server = `0100007F:${socket.localPort.toString(16).toUpperCase().padStart(4, "0")}`;
  const table = readFileSync("/proc/net/tcp", "utf8");
  for (const line of table.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields[1] === client && fields[2] === server) return Number(fields[7]);
  }
}
export function memoryService(options: { store: MemoryStore; auth: MemoryAuth; enabled: () => boolean; peerUid?: (request: IncomingMessage) => number | undefined }) {
  const { store, auth } = options;
  const principal = (request: IncomingMessage): Principal | undefined => {
    const supplied = request.headers[MEMORY_TOKEN_HEADER];
    if (typeof supplied === "string") {
      if (auth.publisherToken && equal(supplied, auth.publisherToken)) return { kind: "publisher" };
      const supervisor = auth.supervisors.find(entry => equal(supplied, entry.token));
      if (supervisor) return { kind: "person", person: supervisor.person };
      const session = store.resolveSession(supplied);
      return session ? { kind: "person", ...session } : undefined;
    }
    const uid = (options.peerUid ?? loopbackUid)(request);
    const person = uid === undefined ? undefined : auth.uidPersons?.[String(uid)];
    return person ? { kind: "person", person } : undefined;
  };
  return createServer(async (request, response) => {
    const send = (status: number, body: unknown) => { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(body)); };
    try {
      if (!options.enabled()) return send(503, { ok: false, error: "disabled", message: "One Kenan is disabled on this host" });
      if (request.method !== "POST" || !["/v1/memory", "/v1/sessions"].includes(request.url ?? "")) return send(404, { ok: false, error: "invalid-request", message: "Unknown memory route" });
      const caller = principal(request);
      if (!caller) return send(403, { ok: false, error: "unauthenticated", message: "Memory access requires a verified local identity" });
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 1_000_000) return send(413, { ok: false, error: "invalid-request", message: "Memory request is too large" }); chunks.push(Buffer.from(chunk)); }
      let input: unknown;
      try { input = JSON.parse(Buffer.concat(chunks).toString()); } catch { return send(400, { ok: false, error: "invalid-request", message: "Memory request must be JSON" }); }
      if (request.url === "/v1/sessions") {
        const threadId = (input as { threadId?: unknown })?.threadId;
        if (caller.kind !== "person" || caller.threadId || typeof threadId !== "string" || !threadId || threadId.length > 200)
          return send(403, { ok: false, error: "unauthenticated", message: "Only a supervisor can issue a thread memory session" });
        return send(200, { ok: true, value: store.session(caller.person, threadId) });
      }
      const operation = validateRequest(input);
      if (!operation) return send(400, { ok: false, error: "invalid-request", message: "Invalid memory operation or fields" });
      if (caller.kind === "publisher" && (operation.operation !== "write" || !operation.item.source.action || !operation.item.source.externalId))
        return send(403, { ok: false, error: "unauthenticated", message: "The journal publisher may only record identified actions" });
      const person = caller.kind === "person" ? caller.person : operation.operation === "write" ? operation.item.setting.person : "";
      const setting = operation.operation === "write" ? operation.item.setting : operation.operation === "log-disclosure" ? operation.disclosure.setting : undefined;
      if (setting && setting.person !== person || caller.kind === "person" && caller.threadId && ((setting && setting.threadId !== caller.threadId) || "context" in operation && operation.context.threadId !== caller.threadId))
        return send(403, { ok: false, error: "unauthenticated", message: "The memory setting does not match this connection" });
      const result: MemoryResult = { ok: true, value: dispatch(store, person, operation) };
      send(200, result);
    } catch { send(500, { ok: false, error: "unavailable", message: "Memory service could not complete the operation" }); }
  });
}
function dispatch(store: MemoryStore, person: string, request: MemoryRequest): MemoryValue {
  switch (request.operation) {
    case "write": return store.write(person, request.item);
    case "search": return store.search(person, request.context, request.query, request.about, request.limit);
    case "read": return store.read(person, request.context, request.ids);
    case "forget": return store.forget(request.ids, request.mode);
    case "log-disclosure": return store.disclose(person, request.disclosure);
    case "disclosures": return store.disclosures(person, request.context, request.limit);
    case "finalize-turn": return store.finalize(person, request.context, request.reply);
  }
}
