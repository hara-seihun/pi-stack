import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { Type } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { memoryClient } from "./client.js";
import { rootRequestResponse } from "./root-transport.js";
import { memoryFolderPrompt } from "./markdown.js";
import { ACTION_TOOL_NAMES, registerActionTools } from "./action-tools.js";
import { oneKenanEnabled } from "./config.js";
import { isMemoryRole, memoryRole, stateValue } from "./explicit-state.js";
import { prepareMemoryEnvironment } from "./session.js";
import { infrastructureReason, reportInfrastructure, type InfrastructureReporter } from "./diagnostics.js";
import { KENAN_ROOT_DEFAULT_PORT, KENAN_REQUEST_HEADER, KENAN_REQUEST_ID_PATTERN, MEMORY_TOKEN_HEADER, MEMORY_READ_DETAIL, type KenanRequestStatus, type MemoryClient, type MemoryRead, type MemoryRequest, type MemoryResult, type ReadContext } from "./contract.js";
const terminalReceiptMessage = "Kenan did not complete this request; actions may already have occurred. Do not resubmit it";
const rootReceiptStates = {
  pending: { message: "Kenan accepted this request. The chosen reply or safe terminal status will arrive automatically in this thread; continue other work. requestId is for optional recovery, not resubmission", isError: false },
  failed: { message: terminalReceiptMessage, isError: true },
  interrupted: { message: terminalReceiptMessage, isError: true },
} satisfies Record<KenanRequestStatus, { message: string; isError: boolean }>;
export const MEMORY_TOOL_NAMES = ["memory_search", "memory_read", "memory_write", "memory_forget", "memory_disclosures", "memory_log_disclosure"];
// Mirrors validation.ts: every string field the service checks as text() must be non-blank and at most 100000 characters.
const nonBlank = (description?: string) => Type.String({ minLength: 1, maxLength: 100_000, pattern: "\\S", ...(description ? { description } : {}) });
const strings = Type.Array(nonBlank(), { minItems: 1, maxItems: 100 });
const optionalTime = Type.Optional(Type.String({ description: "ISO 8601 date-time, e.g. 2026-10-09T19:30:00-07:00" }));
const sourceDetail = {
  action: Type.Optional(nonBlank("Action identifier for an action record, e.g. email.send")),
  externalId: Type.Optional(nonBlank("Stable external identifier of the action, e.g. a message ID")),
};
/** At least one of saidBy or actedFor is required; the memory service rejects a source with neither. */
export const memorySourceSchema = Type.Union([
  Type.Object({ saidBy: nonBlank("Person ID of who said or stated it"), actedFor: Type.Optional(nonBlank("Person ID an action was taken for")), ...sourceDetail }),
  Type.Object({ actedFor: nonBlank("Person ID an action was taken for"), ...sourceDetail }),
], { description: "Provenance. Must include saidBy (who said it) or actedFor (whom an action served), or both. Action records use actedFor with action and externalId." });
export interface MemoryToolOptions {
  env: NodeJS.ProcessEnv;
  client?: MemoryClient;
  rootTransport?: typeof fetch;
  rootTimeoutMs?: number;
  report?: InfrastructureReporter;
  ask: (id: string, question: string, suggestions: string[]) => Promise<unknown>;
}
export function memoryExtension(options: MemoryToolOptions) {
  return (pi: ExtensionAPI) => {
    let initialized = false;
    if (oneKenanEnabled(options.env)) {
      registerMemoryTools(options, pi);
      initialized = true;
    }
    pi.on("before_agent_start", async event => {
      const names = new Set([...MEMORY_TOOL_NAMES, ...ACTION_TOOL_NAMES, "ask_kenan"]);
      if (!oneKenanEnabled(options.env)) {
        if (initialized) pi.setActiveTools(pi.getActiveTools().filter(name => !names.has(name)));
        return;
      }
      if (!initialized) {
        registerMemoryTools(options, pi);
        initialized = true;
      }
      pi.setActiveTools([...new Set([...pi.getActiveTools(), ...pi.getAllTools().filter(tool => names.has(tool.name)).map(tool => tool.name)])]);
      const guidance = readFileSync(new URL(memoryRole(options.env.PI_KENAN_MEMORY_ROLE) === "root" ? "../discretion.md" : "../person.md", import.meta.url), "utf8");
      const folder = memoryFolderPrompt(options.env.PI_KENAN_MEMORY_FOLDER);
      return { systemPrompt: `${event.systemPrompt}\n\n${guidance}\n\n${folder.ok ? folder.value : `Memory folder unavailable: ${folder.error.message}. Expanded standing delegation is unset; explicit requests retain their stated scope.`}` };
    });
  };
}
function registerMemoryTools(options: MemoryToolOptions, pi: ExtensionAPI) {
    const threadId = options.env.PI_THREAD_ID;
    if (!threadId) throw new Error("Kenan memory tools require a thread identity");
    const root = memoryRole(options.env.PI_KENAN_MEMORY_ROLE) === "root";
    if (root && (!options.env.PI_KENAN_MEMORY_TOKEN || !options.env.PI_KENAN_MEMORY_PERSON))
      throw new Error("Root memory requires an admitted root capability");
    const room = options.env.PI_REMOTE_ROOMS_RUNTIME === "1";
    let pending: Promise<MemoryResult<unknown>> | undefined;
    const ensureSession = async (): Promise<MemoryResult<unknown>> => {
      if (!oneKenanEnabled(options.env)) return { ok: false, error: "disabled", message: "One Kenan is disabled on this host" };
      if (options.env.PI_KENAN_MEMORY_ROLE !== undefined && !isMemoryRole(options.env.PI_KENAN_MEMORY_ROLE)) return { ok: false, error: "unauthenticated", message: "Unknown memory role" };
      if (options.env.PI_KENAN_MEMORY_TOKEN && options.env.PI_KENAN_MEMORY_PERSON && (root || options.env.PI_KENAN_MEMORY_ROLE === "person")) return { ok: true, value: undefined };
      if (root) return { ok: false, error: "unauthenticated", message: "Root memory requires an admitted root capability" };
      if (pending) return pending;
      pending = prepareMemoryEnvironment(options.env, threadId);
      try { return await pending; } finally { pending = undefined; }
    };
    const failure = (result: MemoryResult<unknown>) => ({ content: [{ type: "text" as const, text: JSON.stringify(result) }], details: { memoryResult: result }, isError: true });
    if (!root) {
      pi.registerTool(defineTool({ name: "ask_kenan", label: "Ask Kenan",
        description: "Ask privileged Kenan about cross-person memory or resources with {request}. A pending receipt returns a requestId; the chosen reply or safe terminal status arrives automatically in this thread, so continue other work. Optional recovery with {requestId} alone retrieves that same request without a new model session or repeating actions. Only his chosen reply or public request status returns. Your authenticated session fixes who asks and the full room audience; you cannot set his prompt, model, tools or context. Never resubmit an uncertain request; only an explicit not-accepted receipt with safeToResubmit:true permits a fresh submission.",
        parameters: Type.Object({ request: Type.Optional(Type.String({ minLength: 1, maxLength: 100_000 })), requestId: Type.Optional(Type.String({ pattern: KENAN_REQUEST_ID_PATTERN })) }),
        execute: async (id, input, signal): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown> | undefined; isError?: boolean }> => {
          if ((input.request === undefined) === (input.requestId === undefined) || input.requestId !== undefined && !new RegExp(KENAN_REQUEST_ID_PATTERN).test(input.requestId))
            return failure({ ok: false, error: "invalid-request", message: "Supply either request to ask, or requestId alone to retrieve an existing request" });
          const session = await ensureSession();
          if (!session.ok) return failure(session);
          const started = performance.now();
          const report = options.report ?? reportInfrastructure;
          const digest = createHash("sha256").update(JSON.stringify([options.env.PI_KENAN_MEMORY_PERSON, threadId, id])).digest("hex").slice(0, 32);
          const requestId = input.requestId ?? `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20)}`;
          const uncertain = (message: string) => {
            const result = { ok: false as const, error: "unavailable" as const, message: `${message}. If recovery is needed, retrieve this request with ask_kenan({requestId:\"${requestId}\"}); do not resubmit the original request`, requestId };
            return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: { memoryResult: result }, isError: true };
          };
          const deadline = AbortSignal.timeout(options.rootTimeoutMs ?? 60_000);
          const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
          try {
            const url = options.env.PI_KENAN_ROOT_URL ?? `http://127.0.0.1:${options.env.PI_KENAN_ROOT_PORT ?? KENAN_ROOT_DEFAULT_PORT}`;
            if (combined.aborted) return uncertain("Kenan's privileged request was cancelled before submission");
            const lookup = input.requestId !== undefined;
            const response = await rootRequestResponse(`${url}/v1/ask${lookup ? `/${requestId}` : ""}`, { method: lookup ? "GET" : "POST", headers: { "content-type": "application/json", [MEMORY_TOKEN_HEADER]: options.env.PI_KENAN_MEMORY_TOKEN!, ...(!lookup ? { [KENAN_REQUEST_HEADER]: requestId } : {}) },
              ...(!lookup ? { body: JSON.stringify({ request: input.request }) } : {}) }, combined, options.rootTransport ?? fetch);
            if (!response.ok) {
              if (response.error === "aborted") {
                const reason = deadline.aborted ? "timeout" : "cancelled";
                report({ component: "root-client", stage: "request", outcome: "failed", reason, durationMs: Math.round(performance.now() - started) });
                return uncertain(deadline.aborted ? "Kenan's privileged request timed out; its outcome is unknown" : "Kenan's privileged request was cancelled; its outcome is unknown");
              }
              report({ component: "root-client", stage: "request", outcome: "failed", reason: "http-error", status: response.status, durationMs: Math.round(performance.now() - started) });
              return uncertain(`Kenan's privileged request is unavailable (HTTP ${response.status}); no action outcome is implied`);
            }
            const result = response.body as any;
            if (result?.requestId === requestId && result.state === "not-accepted" && result.safeToResubmit === true && !("reply" in result) && !("status" in result)) {
              const receipt = { requestId, state: "not-accepted" as const, safeToResubmit: true as const,
                message: "Root did not accept this request, and its old ID is fenced against delayed execution. You may submit the original request again as a new request." };
              report({ component: "root-client", stage: "request", outcome: "ok", status: response.status, durationMs: Math.round(performance.now() - started) });
              return { content: [{ type: "text" as const, text: JSON.stringify(receipt) }], details: { rootRequest: receipt } };
            }
            if (result?.requestId === requestId && typeof result.status === "string" && Object.hasOwn(rootReceiptStates, result.status) && !("reply" in result) && !("state" in result) && !("safeToResubmit" in result)) {
              const receiptState = stateValue(rootReceiptStates, result.status as KenanRequestStatus);
              const queued = result.status === "pending" && result.reason === "global-agent-capacity";
              const receipt = { requestId, status: result.status, message: queued ? "Queued for the shared global execution capacity; no new native session has started. The chosen reply will arrive automatically." : receiptState.message, ...(queued ? { reason: "global-agent-capacity" } : {}) };
              report({ component: "root-client", stage: "request", outcome: "ok", status: response.status, durationMs: Math.round(performance.now() - started) });
              return { content: [{ type: "text" as const, text: JSON.stringify(receipt) }], details: { rootRequest: receipt }, isError: receiptState.isError };
            }
            const reply = result?.reply;
            if (!result || typeof result !== "object" || Array.isArray(result) || "status" in result || "state" in result || "safeToResubmit" in result || typeof reply !== "string") {
              report({ component: "root-client", stage: "request", outcome: "failed", reason: "invalid-response", status: response.status, durationMs: Math.round(performance.now() - started) });
              return uncertain("Kenan's privileged context returned an invalid response");
            }
            report({ component: "root-client", stage: "request", outcome: "ok", status: response.status, durationMs: Math.round(performance.now() - started) });
            return { content: [{ type: "text" as const, text: reply }], details: undefined };
          } catch (error) {
            const reason = combined.aborted ? deadline.aborted ? "timeout" : "cancelled" : infrastructureReason(error);
            report({ component: "root-client", stage: "request", outcome: "failed", reason, durationMs: Math.round(performance.now() - started) });
            const message = reason === "timeout" ? "Kenan's privileged request timed out; its outcome is unknown" : combined.aborted ? "Kenan's privileged request was cancelled; its outcome is unknown" : "Kenan's privileged context is unavailable; ordinary work can continue";
            return uncertain(message);
          }
        },
      }));
    }
    if (room && !root) return;
    registerActionTools(pi, options.env);
    let turnId = randomUUID();
    pi.on("turn_start", () => { turnId = randomUUID(); });
    const roomId = options.env.PI_REMOTE_ROOM_ID ?? options.env.PI_KENAN_MEMORY_ROOM_ID;
    const context = (): ReadContext => ({ threadId, turnId, ...(roomId ? { roomId } : {}) });
    const setting = () => ({ person: options.env.PI_KENAN_MEMORY_PERSON ?? "", threadId, ...(roomId ? { roomId } : {}) });
    const request = async (input: MemoryRequest): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown>; isError: boolean }> => {
      const session = await ensureSession();
      if (!session.ok) return failure(session);
      if (input.operation === "write") input = { ...input, item: { ...input.item, setting: setting() } };
      if (input.operation === "log-disclosure") input = { ...input, disclosure: { ...input.disclosure, setting: setting() } };
      const client = options.client ?? memoryClient({ url: options.env.PI_KENAN_MEMORY_URL, token: options.env.PI_KENAN_MEMORY_TOKEN });
      const result: MemoryResult<any> = await client.request(input);
      const report = result.ok && result.value && "readReport" in result.value ? (result.value as MemoryRead<unknown>).readReport : undefined;
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: { memoryResult: result, ...(report ? { [MEMORY_READ_DETAIL]: report } : {}) }, isError: !result.ok };
    };
    pi.registerTool(defineTool({ name: "memory_search", label: "Search Kenan's memory",
      description: root ? "Search unrestricted host memory for root Kenan's discretion. Ranked tolerant natural terms; about uses registered person IDs; empty query lists recent items. Stopped items excluded." : "Search your person's own memory and recipient-relevant action records. Ranked natural terms; about must be your verified person ID. Empty query lists accessible items. Use ask_kenan for cross-person questions; this direct view is not the whole account.",
      parameters: Type.Object({ query: Type.String({ maxLength: 10_000 }), about: Type.Optional(strings), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
      execute: async (_id, input) => request({ operation: "search", ...input, context: context() }),
    }));
    pi.registerTool(defineTool({ name: "memory_read", label: "Read Kenan's memory",
      description: root ? "Read host memory for privileged Kenan's judgment; access is not permission to repeat private content." : "Read accessible own-person memory/action records by ID. Other-person or shared facts require ask_kenan.", parameters: Type.Object({ ids: strings }),
      execute: async (_id, input) => request({ operation: "read", ...input, context: context() }),
    }));
    pi.registerTool(defineTool({ name: "memory_write", label: "Remember",
      description: "Journal an accountable action with its subjects, provenance and privacy. Working facts, decisions, calendar and work state belong in the granted Markdown memory folder, not a second task ledger. source must include saidBy (person who said it) or actedFor (person an action was taken for); action records use actedFor with action and externalId. This connection supplies the verified setting and person.",
      parameters: Type.Object({ text: nonBlank(), about: strings, obviouslyPrivate: Type.Boolean(), occurredAt: optionalTime, source: memorySourceSchema }),
      execute: async (_id, input) => request({ operation: "write", item: { ...input, setting: setting() } }),
    }));
    pi.registerTool(defineTool({ name: "memory_forget", label: "Forget",
      description: "Delete stored items or stop using them. Omit mode if the person has not specified which: the tool asks and makes no change.",
      parameters: Type.Object({ ids: strings, mode: Type.Optional(Type.Union([Type.Literal("delete"), Type.Literal("stop-using")])) }),
      execute: async (id, input) => {
        if (!input.mode) {
          const question = "Delete the stored memory, or keep it but stop using it?";
          const asked = await options.ask(id, question, ["Delete it", "Stop using it"]);
          return { content: [{ type: "text" as const, text: JSON.stringify({ clarificationRequired: true, question, asked }) }], details: { clarificationRequired: true } };
        }
        return request({ operation: "forget", ids: input.ids, mode: input.mode });
      },
    }));
    pi.registerTool(defineTool({ name: "memory_disclosures", label: "What Kenan told people about me",
      description: "Read the disclosure log about the verified asking person. Answer from this record, preserving other people's confidences.",
      parameters: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), about: Type.Optional(Type.String({ minLength: 1, maxLength: 100_000, pattern: "\\S", description: root ? "Person whose disclosure account to consult; defaults to authenticated requester." : "Your own verified person ID only; broader account requires ask_kenan." })) }),
      execute: async (_id, input) => request({ operation: "disclosures", ...input, context: context() }),
    }));
    pi.registerTool(defineTool({ name: "memory_log_disclosure", label: "Record a disclosure",
      description: "Log exactly what Kenan told whom about whom, including acknowledgements and refusals about private information.",
      parameters: Type.Object({ text: nonBlank(), about: strings, to: strings, memoryIds: Type.Optional(strings), occurredAt: optionalTime }),
      execute: async (_id, input) => request({ operation: "log-disclosure", disclosure: { ...input, setting: setting() } }),
    }));
}
