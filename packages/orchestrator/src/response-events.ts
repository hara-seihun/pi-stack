import { isProxy } from "node:util/types";
import type { ResponseStreamEvent } from "openai/resources/responses/responses";
import type { VariantResult } from "./threads/runtime-events.js";

export type ResponseEventKind = "created" | "completed" | "failed" | "incomplete" | "error" | "item_done" | "progress";
// Progress events carry no durable result. Every known SDK event still gets an explicit decision.
const responseEvents = {
  "response.created": "created", "response.completed": "completed", "response.failed": "failed", "response.incomplete": "incomplete", error: "error",
  "response.output_item.done": "item_done",
  keepalive: "progress",
  "response.audio.delta": "progress", "response.audio.done": "progress",
  "response.audio.transcript.delta": "progress", "response.audio.transcript.done": "progress",
  "response.code_interpreter_call_code.delta": "progress", "response.code_interpreter_call_code.done": "progress",
  "response.code_interpreter_call.completed": "progress", "response.code_interpreter_call.in_progress": "progress", "response.code_interpreter_call.interpreting": "progress",
  "response.content_part.added": "progress", "response.content_part.done": "progress",
  "response.file_search_call.completed": "progress", "response.file_search_call.in_progress": "progress", "response.file_search_call.searching": "progress",
  "response.function_call_arguments.delta": "progress", "response.function_call_arguments.done": "progress",
  "response.in_progress": "progress", "response.output_item.added": "progress",
  "response.reasoning_summary_part.added": "progress", "response.reasoning_summary_part.done": "progress",
  "response.reasoning_summary_text.delta": "progress", "response.reasoning_summary_text.done": "progress",
  "response.reasoning_text.delta": "progress", "response.reasoning_text.done": "progress",
  "response.refusal.delta": "progress", "response.refusal.done": "progress",
  "response.output_text.delta": "progress", "response.output_text.done": "progress",
  "response.web_search_call.completed": "progress", "response.web_search_call.in_progress": "progress", "response.web_search_call.searching": "progress",
  "response.image_generation_call.completed": "progress", "response.image_generation_call.generating": "progress", "response.image_generation_call.in_progress": "progress", "response.image_generation_call.partial_image": "progress",
  "response.mcp_call_arguments.delta": "progress", "response.mcp_call_arguments.done": "progress",
  "response.mcp_call.completed": "progress", "response.mcp_call.failed": "progress", "response.mcp_call.in_progress": "progress",
  "response.mcp_list_tools.completed": "progress", "response.mcp_list_tools.failed": "progress", "response.mcp_list_tools.in_progress": "progress",
  "response.output_text.annotation.added": "progress", "response.queued": "progress",
  "response.custom_tool_call_input.delta": "progress", "response.custom_tool_call_input.done": "progress",
} satisfies Record<ResponseStreamEvent["type"] | "keepalive", ResponseEventKind>;

export interface ResponseObservation { kind: ResponseEventKind; event: Record<string, any> }
export function parseResponseEvent(value: unknown): VariantResult<ResponseObservation> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "Provider response event must be an object" };
  const event = value as Record<string, unknown>;
  if (typeof event.type !== "string" || !Object.hasOwn(responseEvents, event.type)) return { ok: false, error: `Unknown provider response event type: ${String(event.type).slice(0, 160)}` };
  const kind = responseEvents[event.type as keyof typeof responseEvents];
  if (["created", "completed", "failed", "incomplete"].includes(kind) && (event.response === null || typeof event.response !== "object" || Array.isArray(event.response))) return { ok: false, error: `Missing response object for ${event.type}` };
  if (kind === "item_done" && (event.item === null || typeof event.item !== "object" || Array.isArray(event.item) || typeof (event.item as Record<string, unknown>).id !== "string")) return { ok: false, error: "Missing output item identity for response.output_item.done" };
  return { ok: true, value: { kind, event } };
}

export const RESPONSE_HEARTBEAT_ADOPTION_PROTOCOL = "retained-response-heartbeat-v1";
export type RetainedResponseParser = { registry: object; parse: typeof parseResponseEvent };
export type ResponseHeartbeatAdoptionResult =
  | { ok: true; value: { protocol: typeof RESPONSE_HEARTBEAT_ADOPTION_PROTOCOL; parsers: number; registries: number; changed: number } }
  | { ok: false; error: { code: "invalid-cohort" | "registry-conflict" | "parser-conflict" | "binding-conflict"; message: string } };

export function adoptRetainedResponseHeartbeats(targets: readonly RetainedResponseParser[]): ResponseHeartbeatAdoptionResult {
  const fail = (code: Extract<ResponseHeartbeatAdoptionResult, { ok: false }>["error"]["code"], message: string): ResponseHeartbeatAdoptionResult => ({ ok: false, error: { code, message } });
  if (!Array.isArray(targets) || !targets.length) return fail("invalid-cohort", "An explicit nonempty retained parser cohort is required");
  const predecessorKeys = Object.keys(responseEvents).filter(key => key !== "keepalive");
  const registries = new Map<object, boolean>();
  for (const target of targets) {
    if (!target || !target.registry || typeof target.registry !== "object" || isProxy(target.registry)
      || Object.getPrototypeOf(target.registry) !== Object.prototype) return fail("registry-conflict", "Retained response registry is not a plain data object");
    if (typeof target.parse !== "function" || isProxy(target.parse) || String(target.parse) !== String(parseResponseEvent)) return fail("parser-conflict", "Retained response parser does not match the source-owned parser");
    const descriptors = Object.getOwnPropertyDescriptors(target.registry);
    const keys = Reflect.ownKeys(descriptors);
    const present = Object.hasOwn(descriptors, "keepalive");
    if (keys.length !== predecessorKeys.length + Number(present)
      || keys.some(key => typeof key !== "string" || !Object.hasOwn(responseEvents, key))) return fail("registry-conflict", "Retained response registry has missing or unknown events");
    for (const key of keys as (keyof typeof responseEvents)[]) {
      const descriptor = descriptors[key];
      if (!("value" in descriptor) || descriptor.value !== responseEvents[key]
        || descriptor.configurable !== true || descriptor.writable !== true || descriptor.enumerable !== true) return fail("registry-conflict", "Retained response registry values or descriptors differ from the approved source");
    }
    if (!present && !Object.isExtensible(target.registry)) return fail("registry-conflict", "Retained response registry cannot accept the heartbeat event");
    const heartbeat = target.parse({ type: "keepalive" });
    const unknown = target.parse({ type: "response.heartbeat_adoption_unknown" });
    if (present ? !heartbeat.ok || heartbeat.value.kind !== "progress" : heartbeat.ok)
      return fail("binding-conflict", "Retained parser and registry heartbeat state disagree");
    if (unknown.ok || !unknown.error.startsWith("Unknown provider response event type:")) return fail("parser-conflict", "Retained parser does not reject unknown provider events");
    registries.set(target.registry, present);
  }
  let changed = 0;
  for (const [registry, present] of registries) if (!present) {
    Object.defineProperty(registry, "keepalive", { value: "progress", configurable: true, writable: true, enumerable: true });
    changed++;
  }
  const bound = targets.every(target => {
    const heartbeat = target.parse({ type: "keepalive" });
    const unknown = target.parse({ type: "response.heartbeat_adoption_unknown" });
    return heartbeat.ok && heartbeat.value.kind === "progress" && !unknown.ok;
  });
  if (!bound) {
    for (const [registry, present] of registries) if (!present) Reflect.deleteProperty(registry, "keepalive");
    return fail("binding-conflict", "Retained parser did not observe its registry; all heartbeat additions were restored");
  }
  return { ok: true, value: { protocol: RESPONSE_HEARTBEAT_ADOPTION_PROTOCOL, parsers: targets.length, registries: registries.size, changed } };
}
