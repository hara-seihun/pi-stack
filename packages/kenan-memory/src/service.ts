import { createServer, type IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { MEMORY_TOKEN_HEADER, type MemoryRequest, type MemoryResult, type MemoryRole, type MemoryValue, type RoomAudienceResolver, type RootResumeConsent, type RootLogConsent } from "./contract.js";
import { MemoryStore } from "./store.js";
import { validateRequest } from "./validation.js";
export interface MemoryAuth {
  supervisors: { person: string; token: string; displayName?: string }[];
  publisherToken?: string;
  rootToken?: string;
  uidPersons?: Record<string, string>;
}
type Principal = { kind: "person"; person: string; role: MemoryRole; threadId?: string } | { kind: "publisher" } | { kind: "root-service" };
const equal = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 100 && v.every(id => typeof id === "string" && id.length > 0 && id.length <= 200);
const fields = (v: Record<string, any>, allowed: string[]) => Object.keys(v).every(key => allowed.includes(key));
export function loopbackUid(request: IncomingMessage): number | undefined {
  const socket = request.socket;
  if (socket.remoteAddress !== "127.0.0.1" || socket.localAddress !== "127.0.0.1" || !socket.remotePort || !socket.localPort) return;
  const client = `0100007F:${socket.remotePort.toString(16).toUpperCase().padStart(4, "0")}`;
  const server = `0100007F:${socket.localPort.toString(16).toUpperCase().padStart(4, "0")}`;
  for (const line of readFileSync("/proc/net/tcp", "utf8").split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f[1] === client && f[2] === server) return Number(f[7]);
  }
}
export function memoryService(options: { store: MemoryStore; auth: MemoryAuth; enabled: () => boolean; peerUid?: (request: IncomingMessage) => number | undefined; roomAudience?: RoomAudienceResolver; releaseCommit?: string }) {
  const { store, auth } = options;
  const principal = (request: IncomingMessage): Principal | undefined => {
    const supplied = request.headers[MEMORY_TOKEN_HEADER];
    if (typeof supplied === "string") {
      if (auth.rootToken && equal(supplied, auth.rootToken)) return { kind: "root-service" };
      if (auth.publisherToken && equal(supplied, auth.publisherToken)) return { kind: "publisher" };
      const supervisor = auth.supervisors.find(entry => equal(supplied, entry.token));
      if (supervisor) return { kind: "person", person: supervisor.person, role: "person" };
      const session = store.resolveSession(supplied);
      return session ? { kind: "person", ...session } : undefined;
    }
    const uid = (options.peerUid ?? loopbackUid)(request);
    const person = uid === undefined ? undefined : auth.uidPersons?.[String(uid)];
    return person ? { kind: "person", person, role: "person" } : undefined;
  };
  return createServer(async (request, response) => {
    const send = (status: number, body: unknown) => { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(body)); };
    const invalid = (message: string) => send(400, { ok: false, error: "invalid-request", message });
    const denied = (message: string) => send(403, { ok: false, error: "unauthenticated", message });
    try {
      if (!options.enabled()) return send(503, { ok: false, error: "disabled", message: "One Kenan is disabled on this host" });
      if (request.method === "GET" && request.url === "/v1/health") return send(200, { ok: true, service: "kenan-memory", releaseCommit: options.releaseCommit ?? null });
      if (request.method !== "POST" || !["/v1/memory", "/v1/sessions", "/v1/root/admit", "/v1/root/finalize-reply", "/v1/root/resume-consent", "/v1/root/log-consent"].includes(request.url ?? ""))
        return send(404, { ok: false, error: "invalid-request", message: "Unknown memory route" });
      const caller = principal(request);
      if (!caller) return denied("Memory access requires a verified local identity");
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 1_000_000) return send(413, { ok: false, error: "invalid-request", message: "Memory request is too large" }); chunks.push(Buffer.from(chunk)); }
      let input: unknown;
      try { input = JSON.parse(Buffer.concat(chunks).toString()); } catch { return invalid("Memory request must be JSON"); }
      if (request.url?.startsWith("/v1/root/")) {
        if (caller.kind !== "root-service") return denied("This operation belongs to the root Kenan service");
        if (!object(input)) return invalid("Root operation must be an object");
        if (["/v1/root/resume-consent", "/v1/root/log-consent"].includes(request.url!)) {
          const resume = request.url === "/v1/root/resume-consent";
          const allowed = resume ? ["rootSessionId", "subject", "question", "answer", "consentId"] : ["rootSessionId", "consentId", "subject", "kind", "text"];
          const identifier = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 200;
          const prose = (value: unknown) => typeof value === "string" && value.trim().length > 0 && value.length <= 100_000;
          if (!fields(input, allowed) || !identifier(input.rootSessionId) || !identifier(input.subject) || !identifier(input.consentId)
            || (resume ? !prose(input.question) || !prose(input.answer) : !["question", "answer"].includes(input.kind) || !prose(input.text))) return invalid("Invalid consent boundary operation");
          if (input.subject === "pi-rooms" || ![...auth.supervisors.map(entry => entry.person), ...Object.values(auth.uidPersons ?? {})].includes(input.subject))
            return invalid("Consent requires a registered individual subject");
          const admitted = store.rootAdmission(input.rootSessionId);
          if (admitted?.roomId) {
            const current = await options.roomAudience?.(admitted.person, admitted.threadId);
            if (!current || current.roomId !== admitted.roomId || [...current.people].sort().join("\0") !== [...admitted.recipients].sort().join("\0"))
              return denied("The original room audience changed; ask again");
          }
          const result = resume ? store.resumeConsent(input as RootResumeConsent) : store.logConsent(input as RootLogConsent);
          return send(result.ok ? 200 : result.error === "unauthenticated" ? 403 : 400, result);
        }
        if (request.url === "/v1/root/admit") {
          if (!fields(input, ["callerToken", "request", "rootSessionId"]) || typeof input.callerToken !== "string" || typeof input.request !== "string" || !input.request.trim() || input.request.length > 100_000
            || input.rootSessionId !== undefined && (typeof input.rootSessionId !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(input.rootSessionId))) return invalid("Invalid root admission");
          const session = store.resolveSession(input.callerToken);
          if (!session || session.role !== "person") return denied("Root requests require a verified person session");
          const audience = await options.roomAudience?.(session.person, session.threadId);
          if (session.person === "pi-rooms" && !audience) return denied("A room request requires its current authenticated audience");
          if (audience && (!strings(audience.people) || !audience.people.length)) return denied("The room audience is unavailable");
          const normalized = input.request.toLocaleLowerCase();
          const subjects = auth.supervisors.filter(entry => [entry.person, entry.displayName].filter(Boolean).some(name => normalized.includes(name!.toLocaleLowerCase()))).map(entry => entry.person);
          const admission = store.admitRoot(session.person, session.threadId, audience?.people ?? [session.person], subjects, audience?.roomId, input.rootSessionId);
          return send(200, { ok: true, value: admission });
        }
        if (!fields(input, ["rootSessionId", "reply", "recipients", "subjects"]) || typeof input.rootSessionId !== "string" || typeof input.reply !== "string" || input.reply.length > 100_000
          || !strings(input.subjects) || input.recipients !== undefined && !strings(input.recipients)) return invalid("Invalid root reply finalization");
        const admitted = store.rootAdmission(input.rootSessionId);
        if (admitted?.roomId) {
          const current = await options.roomAudience?.(admitted.person, admitted.threadId);
          if (!current || [...current.people].sort().join("\0") !== [...admitted.recipients].sort().join("\0")) return denied("The room audience changed before the reply; ask again");
        }
        const result = store.finalizeRootReply({ rootSessionId: input.rootSessionId, reply: input.reply, subjects: input.subjects, ...(input.recipients ? { recipients: input.recipients } : {}) });
        return send(result.ok ? 200 : result.error === "unauthenticated" ? 403 : 400, result);
      }
      if (caller.kind === "root-service") return denied("The root service must use an admitted root memory session");
      if (request.url === "/v1/sessions") {
        if (caller.kind !== "person" || caller.threadId || caller.role !== "person") return denied("Only a supervisor can issue a person memory session");
        if (!object(input) || !fields(input, ["threadId"]) || typeof input.threadId !== "string" || !input.threadId || input.threadId.length > 200) return invalid("Invalid person session request");
        return send(200, { ok: true, value: store.session(caller.person, input.threadId, "person") });
      }
      const operation = validateRequest(input);
      if (!operation) return invalid("Invalid memory operation or fields");
      if (caller.kind === "publisher" && (operation.operation !== "write" || !operation.item.source.action || !operation.item.source.externalId)) return denied("The journal publisher may only record identified actions");
      const person = caller.kind === "person" ? caller.person : operation.operation === "write" ? operation.item.setting.person : "";
      const role = caller.kind === "person" ? caller.role : "root";
      const setting = operation.operation === "write" ? operation.item.setting : operation.operation === "log-disclosure" ? operation.disclosure.setting : undefined;
      if (setting && setting.person !== person || caller.kind === "person" && caller.threadId && ((setting && setting.threadId !== caller.threadId) || "context" in operation && operation.context.threadId !== caller.threadId)) return denied("The memory setting does not match this connection");
      if (role === "person") {
        if (operation.operation === "disclosures" && operation.about && operation.about !== person) return denied("Cross-person accountability belongs to ask_kenan");
        if (operation.operation === "search" && operation.about?.some(id => id !== person)) return denied("Cross-person search belongs to ask_kenan");
        if (operation.operation === "write") {
          const item = operation.item;
          const ownSource = (!item.source.saidBy || item.source.saidBy === person) && (!item.source.actedFor || item.source.actedFor === person);
          const ownSubjects = item.about.every(id => id === person);
          const ownAction = !!item.source.action && item.source.actedFor === person && item.about.includes(person);
          if (!ownSource || !ownSubjects && !ownAction) return denied("Cross-person memory writes belong to ask_kenan");
        }
        if (operation.operation === "forget" && !store.canForget(person, operation.ids)) return denied("Forgetting shared or other-person memory belongs to ask_kenan");
        if (operation.operation === "log-disclosure" && operation.disclosure.about.some(id => id !== person)) return denied("Cross-person disclosure accounting belongs to ask_kenan");
        if (operation.operation === "finalize-turn") return denied("Root disclosure finalization belongs to the root boundary");
      }
      const result: MemoryResult = { ok: true, value: dispatch(store, person, role, operation) };
      send(200, result);
    } catch { send(500, { ok: false, error: "unavailable", message: "Memory service could not complete the operation" }); }
  });
}
function dispatch(store: MemoryStore, person: string, role: MemoryRole, request: MemoryRequest): MemoryValue {
  switch (request.operation) {
    case "write": return store.write(person, request.item);
    case "search": return store.search(person, request.context, request.query, request.about, request.limit, role);
    case "read": return store.read(person, request.context, request.ids, role);
    case "forget": return store.forget(request.ids, request.mode);
    case "log-disclosure": return store.disclose(person, request.disclosure);
    case "disclosures": return store.disclosures(person, request.context, request.limit, role, request.about);
    case "finalize-turn": return store.finalize(person, request.context, request.reply);
  }
}
