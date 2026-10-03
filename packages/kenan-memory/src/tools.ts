import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { memoryClient } from "./client.js";
import { oneKenanEnabled } from "./config.js";
import { prepareMemoryEnvironment } from "./session.js";
import { infrastructureReason, reportInfrastructure, type InfrastructureReporter } from "./diagnostics.js";
import { KENAN_ROOT_DEFAULT_PORT, MEMORY_TOKEN_HEADER, MEMORY_READ_DETAIL, type MemoryClient, type MemoryRead, type MemoryRequest, type MemoryResult, type ReadContext } from "./contract.js";
export const MEMORY_TOOL_NAMES = ["memory_search", "memory_read", "memory_write", "memory_forget", "memory_disclosures", "memory_log_disclosure"];
const strings = Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 100 });
const optionalTime = Type.Optional(Type.String());
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
    pi.on("before_agent_start", event => {
      const names = new Set([...MEMORY_TOOL_NAMES, "ask_kenan"]);
      if (!oneKenanEnabled(options.env)) {
        if (initialized) pi.setActiveTools(pi.getActiveTools().filter(name => !names.has(name)));
        return;
      }
      if (!initialized) {
        registerMemoryTools(options, pi);
        initialized = true;
      }
      pi.setActiveTools([...new Set([...pi.getActiveTools(), ...pi.getAllTools().filter(tool => names.has(tool.name)).map(tool => tool.name)])]);
      const guidance = readFileSync(new URL(options.env.PI_KENAN_MEMORY_ROLE === "root" ? "../discretion.md" : "../person.md", import.meta.url), "utf8");
      return { systemPrompt: `${event.systemPrompt}\n\n${guidance}` };
    });
  };
}
function registerMemoryTools(options: MemoryToolOptions, pi: ExtensionAPI) {
    const threadId = options.env.PI_THREAD_ID;
    if (!threadId) throw new Error("Kenan memory tools require a thread identity");
    const root = options.env.PI_KENAN_MEMORY_ROLE === "root";
    if (root && (!options.env.PI_KENAN_MEMORY_TOKEN || !options.env.PI_KENAN_MEMORY_PERSON))
      throw new Error("Root memory requires an admitted root capability");
    const room = options.env.PI_REMOTE_ROOMS_RUNTIME === "1";
    let pending: Promise<MemoryResult<unknown>> | undefined;
    const ensureSession = async (): Promise<MemoryResult<unknown>> => {
      if (!oneKenanEnabled(options.env)) return { ok: false, error: "disabled", message: "One Kenan is disabled on this host" };
      if (options.env.PI_KENAN_MEMORY_TOKEN && options.env.PI_KENAN_MEMORY_PERSON && (root || options.env.PI_KENAN_MEMORY_ROLE === "person")) return { ok: true, value: undefined };
      if (root) return { ok: false, error: "unauthenticated", message: "Root memory requires an admitted root capability" };
      if (pending) return pending;
      pending = prepareMemoryEnvironment(options.env, threadId);
      try { return await pending; } finally { pending = undefined; }
    };
    const failure = (result: MemoryResult<unknown>) => ({ content: [{ type: "text" as const, text: JSON.stringify(result) }], details: { memoryResult: result }, isError: true });
    if (!root) {
      pi.registerTool(defineTool({ name: "ask_kenan", label: "Ask Kenan",
        description: "Ask privileged Kenan about cross-person memory or resources. Only his reply returns. Your authenticated session fixes who asks and the full room audience; you cannot set his prompt, model, tools or context.",
        parameters: Type.Object({ request: Type.String({ minLength: 1, maxLength: 100_000 }) }),
        execute: async (_id, input, signal) => {
          const session = await ensureSession();
          if (!session.ok) return failure(session);
          const started = performance.now();
          const report = options.report ?? reportInfrastructure;
          const deadline = AbortSignal.timeout(options.rootTimeoutMs ?? 120_000);
          const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
          try {
            const url = options.env.PI_KENAN_ROOT_URL ?? `http://127.0.0.1:${options.env.PI_KENAN_ROOT_PORT ?? KENAN_ROOT_DEFAULT_PORT}`;
            const response = await (options.rootTransport ?? fetch)(`${url}/v1/ask`, { method: "POST", headers: { "content-type": "application/json", [MEMORY_TOKEN_HEADER]: options.env.PI_KENAN_MEMORY_TOKEN! },
              body: JSON.stringify(input), signal: combined });
            if (!response.ok) {
              report({ component: "root-client", stage: "request", outcome: "failed", reason: "http-error", status: response.status, durationMs: Math.round(performance.now() - started) });
              await response.body?.cancel();
              return failure({ ok: false, error: "unavailable", message: `Kenan's privileged context could not answer (HTTP ${response.status}); ordinary work can continue` });
            }
            const result = await response.json() as any;
            const reply = result?.reply ?? (result?.ok === true ? result.value?.reply : undefined);
            if (typeof reply !== "string") {
              report({ component: "root-client", stage: "request", outcome: "failed", reason: "invalid-response", status: response.status, durationMs: Math.round(performance.now() - started) });
              return failure({ ok: false, error: "unavailable", message: "Kenan's privileged context returned an invalid response; ordinary work can continue" });
            }
            report({ component: "root-client", stage: "request", outcome: "ok", status: response.status, durationMs: Math.round(performance.now() - started) });
            return { content: [{ type: "text" as const, text: reply }], details: undefined };
          } catch (error) {
            const reason = combined.aborted ? deadline.aborted ? "timeout" : "cancelled" : infrastructureReason(error);
            report({ component: "root-client", stage: "request", outcome: "failed", reason, durationMs: Math.round(performance.now() - started) });
            const message = reason === "timeout" ? "Kenan's privileged request timed out; its outcome is unknown" : combined.aborted ? "Kenan's privileged request was cancelled; its outcome is unknown" : "Kenan's privileged context is unavailable; ordinary work can continue";
            return failure({ ok: false, error: "unavailable", message });
          }
        },
      }));
    }
    if (room && !root) return;
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
      parameters: Type.Object({ query: Type.String(), about: Type.Optional(strings), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
      execute: async (_id, input) => request({ operation: "search", ...input, context: context() }),
    }));
    pi.registerTool(defineTool({ name: "memory_read", label: "Read Kenan's memory",
      description: root ? "Read host memory for privileged Kenan's judgment; access is not permission to repeat private content." : "Read accessible own-person memory/action records by ID. Other-person or shared facts require ask_kenan.", parameters: Type.Object({ ids: strings }),
      execute: async (_id, input) => request({ operation: "read", ...input, context: context() }),
    }));
    pi.registerTool(defineTool({ name: "memory_write", label: "Remember",
      description: "Record a durable memory, its subjects, provenance and privacy. This connection supplies the verified setting and person.",
      parameters: Type.Object({ text: Type.String(), about: strings, obviouslyPrivate: Type.Boolean(), occurredAt: optionalTime,
        source: Type.Object({ saidBy: Type.Optional(Type.String()), actedFor: Type.Optional(Type.String()), action: Type.Optional(Type.String()), externalId: Type.Optional(Type.String()) }) }),
      execute: async (_id, input) => request({ operation: "write", item: { ...input, setting: setting() } }),
    }));
    pi.registerTool(defineTool({ name: "memory_forget", label: "Forget",
      description: "Delete stored items or stop using them. Omit mode if the person has not specified which: the tool asks and makes no change.",
      parameters: Type.Object({ ids: strings, mode: Type.Optional(Type.Union([Type.Literal("delete"), Type.Literal("stop-using")])) }),
      execute: async (id, input) => {
        if (!input.mode) {
          const question = "When you say forget, do you mean delete the stored memory, or keep it but stop using it?";
          const asked = await options.ask(id, question, ["Delete it", "Stop using it"]);
          return { content: [{ type: "text" as const, text: JSON.stringify({ clarificationRequired: true, question, asked }) }], details: { clarificationRequired: true } };
        }
        return request({ operation: "forget", ids: input.ids, mode: input.mode });
      },
    }));
    pi.registerTool(defineTool({ name: "memory_disclosures", label: "What Kenan told people about me",
      description: "Read the disclosure log about the verified asking person. Answer from this record, preserving other people's confidences.",
      parameters: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), about: Type.Optional(Type.String({ description: root ? "Person whose disclosure account to consult; defaults to authenticated requester." : "Your own verified person ID only; broader account requires ask_kenan." })) }),
      execute: async (_id, input) => request({ operation: "disclosures", ...input, context: context() }),
    }));
    pi.registerTool(defineTool({ name: "memory_log_disclosure", label: "Record a disclosure",
      description: "Log exactly what Kenan told whom about whom, including acknowledgements and refusals about private information.",
      parameters: Type.Object({ text: Type.String(), about: strings, to: strings, memoryIds: Type.Optional(strings), occurredAt: optionalTime }),
      execute: async (_id, input) => request({ operation: "log-disclosure", disclosure: { ...input, setting: setting() } }),
    }));
}
