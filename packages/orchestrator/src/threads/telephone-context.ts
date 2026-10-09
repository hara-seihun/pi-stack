import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fixedModelSystem } from "./pi-raw.js";

export const TELEPHONE_CONTEXT_ARGUMENT = "--telephone-context";
export type TelephoneContext = { callId: string; instructions: string };
export function isTelephoneContext(value: unknown): value is TelephoneContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>;
  return Object.keys(c).length === 2 && typeof c.callId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(c.callId)
    && typeof c.instructions === "string" && c.instructions.trim().length > 0 && Buffer.byteLength(c.instructions) <= 32_000;
}
export function telephoneModelContext(context: TelephoneContext) {
  return (pi: ExtensionAPI) => {
    pi.on("before_agent_start", () => ({ systemPrompt: context.instructions }));
    pi.on("context_with_system", event => ({ messages: fixedModelSystem(event.messages, context.instructions) }));
    pi.on("tool_call", () => ({ block: true, reason: "External telephone conversations have no host or operator capabilities" }));
  };
}
