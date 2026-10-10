import { createServer, type IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { PersonTimezone, SettingsResult } from "pi-orchestrator/person-timezone";
import type { Authorization, PermissionResult } from "pi-orchestrator/permissions";
import type { RootAdmission } from "./contract.js";
import { KENAN_REQUEST_ID_PATTERN, MEMORY_TOKEN_HEADER, type MemoryRequest, type MemoryResult, type MemoryRole, type MemoryValue, type RoomAudienceResolver, type MemoryItem, type Disclosure, type MemoryDataRequest, type MemoryDataProjection, type RootResumeConsent, type RootLogConsent, type RootLogNotification, type RootLogRequestStatus } from "./contract.js";
import { MemoryStore } from "./store.js";
import { validateRequest } from "./validation.js";
import { unreachable } from "./explicit-state.js";
export interface MemoryAuth {
  supervisors: { person: string; token: string; displayName?: string; timezoneFile?: string }[];
  publisherToken?: string;
  rootToken?: string;
  uidPersons?: Record<string, string>;
}
export type MemoryPrincipal = { kind: "person"; person: string; role: MemoryRole; threadId?: string } | { kind: "publisher" } | { kind: "root-service" };
export type MemoryAuthorizationRecord = { about: readonly string[]; obviouslyPrivate?: boolean };
export type MemoryAuthorizer = (request: { caller: MemoryPrincipal; route: string; input: unknown; record?: MemoryAuthorizationRecord }) => PermissionResult<Authorization>;
export interface MemoryServiceOptions {
  store: MemoryStore;
  auth: MemoryAuth;
  authorize: MemoryAuthorizer;
  forget?: (request: { caller: MemoryPrincipal; ids: string[]; mode: import("./contract.js").ForgetMode }) => Promise<MemoryResult<MemoryValue>>;
  data?: (request: { caller: MemoryPrincipal; request: MemoryDataRequest }) => Promise<MemoryResult<MemoryDataProjection>>;
  enabled: () => boolean;
  peerUid?: (request: IncomingMessage) => number | undefined;
  roomAudience?: RoomAudienceResolver;
  timezone?: (person: string) => SettingsResult<PersonTimezone | null>;
  releaseCommit?: string;
}
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
export function memoryService(options: MemoryServiceOptions) {
  const { store, auth } = options;
  const withTimezone = (admission: RootAdmission): MemoryResult<RootAdmission> => {
    if (!options.timezone) return { ok: true, value: admission };
    const timezone = options.timezone(admission.person);
    return timezone.ok ? { ok: true, value: { ...admission, timezone: timezone.value } }
      : { ok: false, error: "unavailable", message: `Authenticated asking-person timezone unavailable: ${timezone.error.message}` };
  };
  const principal = (request: IncomingMessage): MemoryPrincipal | undefined => {
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
      if (request.method !== "POST" || !["/v1/memory", "/v1/sessions", "/v1/root/admit", "/v1/root/finalize-reply", "/v1/root/resume-consent", "/v1/root/log-consent", "/v1/root/authorize-request", "/v1/root/authenticate-caller", "/v1/root/resume-request", "/v1/root/log-notification", "/v1/root/log-request-status"].includes(request.url ?? ""))
        return send(404, { ok: false, error: "invalid-request", message: "Unknown memory route" });
      const caller = principal(request);
      if (!caller) return denied("Memory access requires a verified local identity");
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 1_000_000) return send(413, { ok: false, error: "invalid-request", message: "Memory request is too large" }); chunks.push(Buffer.from(chunk)); }
      let input: unknown;
      try { input = JSON.parse(Buffer.concat(chunks).toString()); } catch { return invalid("Memory request must be JSON"); }
      if (typeof options.authorize !== "function") return send(503, { ok: false, error: "unavailable", message: "Unified memory authorization is unset" });
      const authorization = await options.authorize({ caller, route: request.url!, input });
      if (!authorization.ok) return send(403, { ok: false, error: "unauthenticated", message: authorization.error.message });
      if (request.url?.startsWith("/v1/root/")) {
        if (caller.kind !== "root-service") return denied("This operation belongs to the root Kenan service");
        if (!object(input)) return invalid("Root operation must be an object");
        const rootSubjects = typeof input.rootSessionId === "string" ? store.authorizationSubjects(input.rootSessionId) : [];
        const asking = typeof input.callerToken === "string" ? store.resolveSession(input.callerToken) : undefined;
        const subjects = [...new Set([...rootSubjects, ...(asking ? [asking.person] : []), ...(strings(input.subjects) ? input.subjects : []), ...(typeof input.subject === "string" ? [input.subject] : []), ...(typeof input.recipient === "string" ? [input.recipient] : [])])];
        if (subjects.length && !options.authorize({ caller, route: request.url!, input, record: { about: subjects, obviouslyPrivate: true } }).ok) return denied("The consultation records are outside the granted subjects");
        if (request.url === "/v1/root/authenticate-caller") {
          if (!fields(input, ["callerToken"]) || typeof input.callerToken !== "string") return invalid("Invalid caller authentication");
          const session = store.resolveSession(input.callerToken);
          if (!session || session.role !== "person") return denied("An authenticated person session is required");
          if (session.person === "pi-rooms" && !await options.roomAudience?.(session.person, session.threadId)) return denied("Room audience is unavailable");
          return send(200, { ok: true, value: { authenticated: true } });
        }
        if (request.url === "/v1/root/authorize-request") {
          if (!fields(input, ["callerToken", "rootSessionId"]) || typeof input.callerToken !== "string" || typeof input.rootSessionId !== "string") return invalid("Invalid request authorization");
          const session = store.resolveSession(input.callerToken);
          const admitted = store.rootAdmission(input.rootSessionId);
          if (!session || session.role !== "person" || !admitted || session.person !== admitted.person || session.threadId !== admitted.threadId) return denied("Request is unavailable to this session");
          const current = await options.roomAudience?.(session.person, session.threadId);
          if (admitted.roomId || current || session.person === "pi-rooms") {
            if (!current || current.roomId !== admitted.roomId || [...current.people].sort().join("\0") !== [...admitted.recipients].sort().join("\0")) return denied("Request is unavailable to this audience");
          }
          return send(200, { ok: true, value: { authorized: true } });
        }
        if (request.url === "/v1/root/resume-request") {
          if (!fields(input, ["rootSessionId"]) || typeof input.rootSessionId !== "string" || !input.rootSessionId) return invalid("Invalid queued root admission");
          const admitted = store.rootAdmission(input.rootSessionId);
          const session = admitted && store.resolveSession(admitted.memoryToken);
          if (!admitted || !session || session.role !== "root" || session.threadId !== admitted.rootSessionId || session.person !== admitted.person) return denied("The original admitted execution is unavailable");
          const current = await options.roomAudience?.(admitted.person, admitted.threadId);
          if (admitted.roomId || current || admitted.person === "pi-rooms") {
            if (!current || current.roomId !== admitted.roomId || [...current.people].sort().join("\0") !== [...admitted.recipients].sort().join("\0")) return denied("The original room audience changed");
          }
          const resolved = withTimezone(admitted);
          return send(resolved.ok ? 200 : 503, resolved);
        }
        if (request.url === "/v1/root/log-request-status") {
          if (!fields(input, ["rootSessionId", "requestId", "status"]) || typeof input.rootSessionId !== "string" || typeof input.requestId !== "string" || !new RegExp(KENAN_REQUEST_ID_PATTERN).test(input.requestId) || !["failed", "interrupted"].includes(input.status)) return invalid("Invalid root request status");
          const admitted = store.rootAdmission(input.rootSessionId);
          if (!admitted) return denied("Request is unavailable");
          if (admitted.roomId) {
            const current = await options.roomAudience?.(admitted.person, admitted.threadId);
            if (!current || current.roomId !== admitted.roomId || [...current.people].sort().join("\0") !== [...admitted.recipients].sort().join("\0")) return denied("The original room audience changed");
          }
          const result = store.logRequestStatus(input as RootLogRequestStatus);
          return send(result.ok ? 200 : 400, result);
        }
        if (request.url === "/v1/root/log-notification") {
          if (!fields(input, ["rootSessionId", "notificationId", "recipient", "text", "subjects", "obviouslyPrivate"])
            || typeof input.rootSessionId !== "string" || !input.rootSessionId || typeof input.notificationId !== "string" || !input.notificationId || input.notificationId.length > 200
            || typeof input.recipient !== "string" || input.recipient === "pi-rooms" || ![...auth.supervisors.map(entry => entry.person), ...Object.values(auth.uidPersons ?? {})].includes(input.recipient)
            || typeof input.text !== "string" || !input.text.trim() || input.text.length > 100_000 || !strings(input.subjects) || typeof input.obviouslyPrivate !== "boolean") return invalid("Invalid root notification");
          const result = store.logNotification(input as RootLogNotification);
          return send(result.ok ? 200 : 400, result);
        }
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
          if (resume) {
            const timezone = admitted && options.timezone?.(admitted.person);
            if (timezone && !timezone.ok) return send(503, { ok: false, error: "unavailable", message: `Authenticated asking-person timezone unavailable: ${timezone.error.message}` });
            const result = store.resumeConsent(input as RootResumeConsent);
            const resolved = result.ok && timezone?.ok ? { ok: true as const, value: { ...result.value, timezone: timezone.value } } : result;
            return send(resolved.ok ? 200 : resolved.error === "unauthenticated" ? 403 : 400, resolved);
          }
          const result = store.logConsent(input as RootLogConsent);
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
          const timezone = options.timezone?.(session.person);
          if (timezone && !timezone.ok) return send(503, { ok: false, error: "unavailable", message: `Authenticated asking-person timezone unavailable: ${timezone.error.message}` });
          const normalized = input.request.toLocaleLowerCase();
          const subjects = auth.supervisors.filter(entry => [entry.person, entry.displayName].filter(Boolean).some(name => normalized.includes(name!.toLocaleLowerCase()))).map(entry => entry.person);
          const admission = store.admitRoot(session.person, session.threadId, audience?.people ?? [session.person], subjects, audience?.roomId, input.rootSessionId);
          return send(200, { ok: true, value: timezone?.ok ? { ...admission, timezone: timezone.value } : admission });
        }
        if (request.url !== "/v1/root/finalize-reply") return invalid("Unknown root operation");
        if (!fields(input, ["rootSessionId", "reply", "recipients", "subjects"]) || typeof input.rootSessionId !== "string" || typeof input.reply !== "string" || input.reply.length > 100_000
          || !strings(input.subjects) || input.recipients !== undefined && !strings(input.recipients)) return invalid("Invalid root reply finalization");
        const admitted = store.rootAdmission(input.rootSessionId);
        if (admitted?.roomId) {
          const current = await options.roomAudience?.(admitted.person, admitted.threadId);
          if (!current || current.roomId !== admitted.roomId || [...current.people].sort().join("\0") !== [...admitted.recipients].sort().join("\0")) return denied("The room audience changed before the reply; ask again");
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
      const validation = validateRequest(input);
      if (!validation.ok) return invalid(validation.reason);
      const operation = validation.request;
      if (caller.kind === "publisher" && (operation.operation !== "write" || !operation.item.source.action || !operation.item.source.externalId)) return denied("The journal publisher may only record identified actions");
      const person = caller.kind === "person" ? caller.person : operation.operation === "write" ? operation.item.setting.person : "";
      const role = caller.kind === "person" ? caller.role : "root";
      const setting = operation.operation === "write" ? operation.item.setting : operation.operation === "log-disclosure" ? operation.disclosure.setting : undefined;
      if (setting && setting.person !== person || caller.kind === "person" && caller.threadId && ((setting && setting.threadId !== caller.threadId) || "context" in operation && operation.context.threadId !== caller.threadId)) return denied("The memory setting does not match this connection");
      if (operation.operation === "data") {
        if (caller.kind !== "person" || !options.data) return send(503, { ok: false, error: "unavailable", message: "Structured memory data is not configured" });
        const audience = caller.threadId ? await options.roomAudience?.(caller.person, caller.threadId) : undefined;
        if (caller.role === "person" && (caller.person === "pi-rooms" || audience)) return denied("Rooms use private consultation for structured memory data");
        const data = await options.data({ caller, request: operation });
        if (!data.ok) return send(data.error === "unauthenticated" ? 403 : data.error === "not-found" ? 404 : data.error === "conflict" ? 409 : data.error === "unavailable" ? 503 : 400, data);
        const subjects = data.value.subjects;
        if (!Array.isArray(subjects) || subjects.length === 0 || subjects.some(subject => typeof subject !== "string" || !subject.trim()) || !options.authorize({ caller, route: request.url!, input, record: { about: subjects, obviouslyPrivate: data.value.obviouslyPrivate } }).ok) return denied("Structured memory data is outside the granted subject scope");
        return send(200, { ok: true, value: options.store.reportData(person, operation.context, data.value.value.dataset, data.value.subjects, data.value.value) });
      }
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
      const permit = (record: MemoryAuthorizationRecord) => options.authorize({ caller, route: request.url!, input, record }).ok;
      const mutationRecords = operation.operation === "write" ? [operation.item] : operation.operation === "log-disclosure" ? [operation.disclosure] : operation.operation === "forget" ? store.authorizationItems(operation.ids) : [];
      if (operation.operation === "forget" && mutationRecords.length !== operation.ids.length || mutationRecords.some(record => !permit(record))) return denied("The memory mutation is outside the granted records");
      if (operation.operation === "forget" && options.forget) {
        const result = await options.forget({ caller, ids: operation.ids, mode: operation.mode });
        return send(result.ok ? 200 : result.error === "unauthenticated" ? 403 : 503, result);
      }
      const result: MemoryResult = { ok: true, value: dispatch(store, person, role, operation, permit, role === "root" && caller.kind === "person" ? authorization.value.principal : person) };
      send(200, result);
    } catch { send(500, { ok: false, error: "unavailable", message: "Memory service could not complete the operation" }); }
  });
}
function dispatch(store: MemoryStore, person: string, role: MemoryRole, request: MemoryRequest, permit: (record: MemoryItem | Disclosure) => boolean, recordedBy: string): MemoryValue {
  switch (request.operation) {
    case "write": return store.write(recordedBy, request.item);
    case "search": return store.search(person, request.context, request.query, request.about, request.limit, role, permit);
    case "read": return store.read(person, request.context, request.ids, role, permit);
    case "forget": return store.forget(request.ids, request.mode);
    case "log-disclosure": return store.disclose(person, request.disclosure);
    case "disclosures": return store.disclosures(person, request.context, request.limit, role, request.about, permit);
    case "finalize-turn": return store.finalize(person, request.context, request.reply);
    case "data": throw new Error("Structured memory data must dispatch through its installed data owner");
  }
  return unreachable(request);
}
