import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";

export function fixedModelSystem(messages: AgentMessage[], instructions: string): AgentMessage[] {
  const current = getCurrentSystemMessage(messages);
  return [{ role: "system", content: instructions, timestamp: current?.timestamp ?? 0,
    ...(current?.toolsAdded ? { toolsAdded: current.toolsAdded } : {}) }, ...messages.filter(message => message.role !== "system")];
}

/** Session argument that selects a raw Pi session: the model receives the conversation and nothing else. */
export const RAW_ARGUMENT = "--raw";
export const SANDBOX_ARGUMENT = "--sandbox";
export const SANDBOX_POLICY_ARGUMENT = "--sandbox-policy";
export type SandboxPolicy = { profile: "public" } | { profile: "benchmark"; gatewaySocket: string };

export function sandboxPolicy(metadata: Record<string, unknown>): SandboxPolicy | undefined {
  if (metadata.sandboxProfile === undefined && metadata.sandboxGateway === undefined) return { profile: "public" };
  const gateway = metadata.sandboxGateway;
  if (metadata.sandboxProfile !== "benchmark" || !gateway || typeof gateway !== "object" || Array.isArray(gateway)) return undefined;
  const socketPath = (gateway as Record<string, unknown>).socketPath;
  return typeof socketPath === "string" && socketPath.startsWith("/") && !socketPath.includes("\0")
    ? { profile: "benchmark", gatewaySocket: socketPath } : undefined;
}

export function isRawSession(args: readonly string[]): boolean {
  return args.includes(RAW_ARGUMENT) || args.includes(SANDBOX_ARGUMENT);
}

export function validSandboxBoundary(metadata: Record<string, unknown>): boolean {
  return metadata.sandbox === undefined
    ? metadata.sandboxProfile === undefined && metadata.sandboxGateway === undefined
    : metadata.sandbox === true && metadata.raw === true && sandboxPolicy(metadata) !== undefined
    && metadata.context === undefined && metadata.execution === undefined && metadata.mode === undefined
    && metadata.meetingId == null && metadata.contextFiles === undefined;
}

/**
 * Pi builds a harness prompt even when no custom prompt exists, so an empty
 * string from the loader is not enough. An empty override from before_agent_start
 * is respected as-is and persists for the turn's model calls.
 */
export function rawModelContext(pi: ExtensionAPI): void {
  pi.on("before_agent_start", () => ({ systemPrompt: "" }));
  pi.on("context_with_system", event => ({ messages: fixedModelSystem(event.messages, "") }));
}
