import { existsSync, readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { createThreadClient, type ThreadApi } from "pi-orchestrator/api";
import { CONSENT_PREFIX, ROOT_CONSENT_HEADER, consentIdValid, consentInboxId } from "kenan-root/consent-contract";
import type { Person } from "./persons";

export interface RootConsentOptions {
  capability(): string | null;
  persons(): readonly Person[];
  client?(person: string, origin: string): ThreadApi;
  roomsOrigin?: string;
}
export function rootConsentCapability(env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const host = env.PI_STACK_HOST_CONFIG ?? env.PI_STACK_HOST_FILE ?? "/etc/pi-stack/host.json";
    if (!existsSync(host) || JSON.parse(readFileSync(host, "utf8")).oneKenan !== true) return null;
    const config = JSON.parse(readFileSync(env.PI_KENAN_CONFIG ?? "/etc/pi-stack/one-kenan.json", "utf8"));
    return readFileSync(env.PI_KENAN_ROOT_CONSENT_TOKEN_FILE ?? config.rootConsentCapabilityFile ?? "/var/lib/pi-kenan/root-consent-capability", "utf8").trim();
  } catch { return null; }
}
const failed = (message: string, status = 503) => Response.json({ ok: false, message }, { status, headers: { "cache-control": "no-store" } });
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value) <= 24_000;
const exact = (body: Record<string, unknown>, keys: string[]) => Object.keys(body).length === keys.length && keys.every(key => key in body);

export function rootConsentHandler(options: RootConsentOptions): (request: Request) => Promise<Response | null> {
  return async request => {
    const path = new URL(request.url).pathname;
    if (!path.startsWith(CONSENT_PREFIX)) return null;
    const expected = options.capability(), supplied = request.headers.get(ROOT_CONSENT_HEADER);
    if (!expected || !supplied || !/^[a-f0-9]{64}$/.test(expected) || !/^[a-f0-9]{64}$/.test(supplied) || supplied.length !== expected.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return new Response("Not found", { status: 404 });
    if (request.method !== "POST" || !["question", "answer", "reply", "notify"].includes(path.slice(CONSENT_PREFIX.length))) return new Response("Not found", { status: 404 });
    const raw = await request.text();
    if (Buffer.byteLength(raw) > 32_768) return failed("Consent request too large", 413);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { return failed("Expected a consent object", 400); }
    if (!body || typeof body !== "object" || Array.isArray(body) || !consentIdValid(body.consentId)) return failed("Invalid consent identity", 400);
    const operation = path.slice(CONSENT_PREFIX.length), id = body.consentId;
    const user = operation === "reply" || operation === "notify" ? body.person : body.subject;
    const person = options.persons().find(person => person.user === user);
    if (!person && !(operation === "reply" && user === "pi-rooms")) return failed("Consent recipient is not registered", 400);
    const origin = person ? `http://127.0.0.1:${person.port}` : options.roomsOrigin ?? "http://127.0.0.1:18822";
    const local = new URL(origin);
    if (local.protocol !== "http:" || local.hostname !== "127.0.0.1" || local.pathname !== "/" || local.username || local.password || local.search || local.hash) return failed("Consent owner is not local");
    const api = options.client?.(String(user), origin) ?? createThreadClient(`${origin}/v1/threads`, fetch, { timeoutMs: 5_000 });
    try {
      if (operation === "notify") {
        if (!exact(body, ["consentId", "person", "text"]) || !text(body.text) || !person) return failed("Invalid notification", 400);
        const threadId = consentInboxId(`notification:${id}`);
        const cwd = String(person.environment.PI_REMOTE_PRIVATE_DIR ?? person.unlock?.mountpoint ?? person.environment.HOME ?? "");
        if (!cwd.startsWith("/")) return failed("Notification inbox has no private workspace");
        const spawned = await api.spawn({ requestId: `notification:${id}:inbox`, id: threadId, title: "Kenan: update", cwd,
          metadata: { workspaceId: String(person.environment.PI_REMOTE_PRIVATE_ID ?? "personal"), profileId: "personal" } });
        if (!spawned.ok) return failed("Recipient's inbox could not accept the notification");
        const delivered = await api.send({ requestId: `notification:${id}:message`, threadId, senderId: "kenan-root", text: body.text, delivery: "steer", source: "notification" });
        return delivered.ok ? Response.json({ ok: true, value: { accepted: true, threadId } }) : failed("Notification was not acknowledged by its recipient");
      }
      if (operation === "question") {
        if (!exact(body, ["consentId", "subject", "text"]) || !text(body.text) || !person) return failed("Invalid consent question", 400);
        const threadId = consentInboxId(id);
        const cwd = String(person.environment.PI_REMOTE_PRIVATE_DIR ?? person.unlock?.mountpoint ?? person.environment.HOME ?? "");
        if (!cwd.startsWith("/")) return failed("Consent inbox has no private workspace");
        const spawned = await api.spawn({ requestId: `consent:${id}:inbox`, id: threadId, title: "Kenan: permission request", cwd,
          metadata: { workspaceId: String(person.environment.PI_REMOTE_PRIVATE_ID ?? "personal"), profileId: "personal", rootConsent: true } });
        if (!spawned.ok) return failed("Subject's inbox could not accept the question");
        const asked = await api.ask({ requestId: `consent:${id}:question`, threadId, questions: [{ question: body.text, suggestions: ["Yes, for this request", "No"] }] });
        if (!asked.ok) return failed("Subject's question was not acknowledged");
        return Response.json({ ok: true, value: { threadId, questionId: asked.value.questionIds[0] } });
      }
      if (operation === "answer") {
        if (!exact(body, ["consentId", "subject", "threadId", "questionId"]) || body.threadId !== consentInboxId(id) || !consentIdValid(body.questionId)) return failed("Invalid consent answer lookup", 400);
        const state = await api.questionState(String(body.threadId), body.questionId);
        if (!state.ok) return failed("Subject's answer could not be read");
        return Response.json({ ok: true, value: { question: state.value.question.question, ...(state.value.answer ? { answer: state.value.answer } : {}) } });
      }
      if (!exact(body, ["consentId", "person", "threadId", "reply"]) || !text(body.threadId) || !text(body.reply)) return failed("Invalid chosen reply", 400);
      const delivered = await api.send({ requestId: `consent:${id}:reply`, threadId: body.threadId, senderId: "kenan-root", text: body.reply, delivery: "steer", source: "notification" });
      return delivered.ok ? Response.json({ ok: true, value: { accepted: true } }) : failed("Chosen reply was not acknowledged by the original thread");
    } catch { return failed("Consent owner is unavailable; retry the same consent identity"); }
  };
}
