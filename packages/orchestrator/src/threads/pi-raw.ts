import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Session argument that selects a raw Pi session: the model receives the conversation and nothing else. */
export const RAW_ARGUMENT = "--raw";

export function isRawSession(args: readonly string[]): boolean {
  return args.includes(RAW_ARGUMENT);
}

/**
 * Pi builds a harness prompt even when no custom prompt exists, so an empty
 * string from the loader is not enough. An empty override from before_agent_start
 * is respected as-is and persists for the turn's model calls.
 */
export function rawModelContext(pi: ExtensionAPI): void {
  pi.on("before_agent_start", () => ({ systemPrompt: "" }));
}
