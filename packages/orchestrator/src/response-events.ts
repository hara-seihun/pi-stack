import type { ResponseStreamEvent } from "openai/resources/responses/responses";
import type { VariantResult } from "./threads/runtime-events.js";

export type ResponseEventKind = "created" | "completed" | "failed" | "incomplete" | "error" | "item_done" | "progress";
// Progress events carry no durable result. Every known SDK event still gets an explicit decision.
const responseEvents = {
  "response.created": "created", "response.completed": "completed", "response.failed": "failed", "response.incomplete": "incomplete", error: "error",
  "response.output_item.done": "item_done",
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
} satisfies Record<ResponseStreamEvent["type"], ResponseEventKind>;

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
