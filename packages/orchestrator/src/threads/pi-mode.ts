import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { threadMode, type ThreadMode } from "./modes.js";

/** The conversation of a moded thread, if this session is one. Workers keep their full toolset. */
export function modeConversation(environment: NodeJS.ProcessEnv): ThreadMode["conversation"] | undefined {
  return environment.PI_THREAD_CAN_SPAWN === "0" ? undefined : threadMode(environment.PI_THREAD_MODE)?.conversation;
}

/** Apply the mode's bash ceiling to the session environment the timeout guard reads. */
export function modeEnvironment(environment: NodeJS.ProcessEnv): void {
  const conversation = modeConversation(environment);
  if (!conversation) return;
  environment.PI_REMOTE_BASH_TIMEOUT_MAX_SECONDS = String(conversation.bashTimeoutSeconds);
  environment.PI_BASH_TIMEOUT_CONTEXT = "This conversation dispatches; anything longer belongs to a worker thread.";
}

/**
 * Before every turn, switch off the tools a dispatching conversation does not keep. Extensions register
 * tools at different times, so the filter runs per turn rather than once at startup.
 */
export function modeTools(environment: NodeJS.ProcessEnv) {
  return (pi: ExtensionAPI) => {
    const conversation = modeConversation(environment);
    if (!conversation) return;
    const kept = new Set(conversation.tools);
    pi.on("before_agent_start", () => {
      const active = pi.getAllTools().map(tool => tool.name).filter(name => kept.has(name));
      if (active.join("\n") !== pi.getActiveTools().join("\n")) pi.setActiveTools(active);
    });
  };
}
