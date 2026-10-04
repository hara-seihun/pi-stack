import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { PiEvent } from "../threads/contracts.js";

/** The agent owns this callback; nested calls and cache warming use the model runtime directly. */
export function observeProviderRequests(session: AgentSession, output: (event: PiEvent) => void): void {
  const transform = session.agent.onPayload;
  session.agent.onPayload = async (payload, model) => {
    const replacement = await transform?.(payload, model);
    output({ type: "model_request_start", emittedAt: Date.now(), sessionId: session.sessionId,
      provider: model.provider, modelId: model.id });
    return replacement;
  };
}
