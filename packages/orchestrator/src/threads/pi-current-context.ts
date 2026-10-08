import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { getCurrentSystemPrompt, getCurrentTools, getToolStateChanges, toToolDeclaration, type Message } from "@earendil-works/pi-ai";
import { CONTEXT_WINDOW_MAX_BYTES, type Result } from "./contracts.js";
import { measureJsonBytes } from "./json-size.js";
import { previewMessageDelivery } from "./message-delivery.js";

type CurrentSession = Pick<AgentSession, "agent" | "systemPrompt" | "messages" | "model" | "getContextUsage">;
export type CurrentContext = {
  source: "runtime";
  systemPrompt: string;
  messages: Message[];
  tools: ReturnType<typeof getCurrentTools>;
  contextUsage: ReturnType<AgentSession["getContextUsage"]>;
  contextModel: string | undefined;
};
export type CurrentContextResult = Result<CurrentContext>;

export async function previewCurrentContext(session: CurrentSession): Promise<CurrentContextResult> {
  const measured = measureJsonBytes(session.messages, CONTEXT_WINDOW_MAX_BYTES);
  if (!measured.ok) return measured;
  try {
    return await previewMessageDelivery(async () => {
      let messages = structuredClone(session.messages);
      // Before the first turn the SDK has not committed its prompt/tool declaration.
      if (!messages.some(message => message.role === "system")) {
        messages = [{ role: "system", content: session.systemPrompt, timestamp: 0,
          toolsAdded: session.agent.state.tools.map(({ name, description, parameters }) => ({ name, description, parameters })) }, ...messages];
      }
      const tools = getToolStateChanges(getCurrentTools(messages), session.agent.state.tools.map(toToolDeclaration));
      if (tools.toolsAdded.length || tools.toolsRemoved.length) {
        messages.push({ role: "system", content: "", timestamp: 0, ...tools });
      }
      if (session.agent.transformContext) messages = await session.agent.transformContext(messages);
      const projected = await session.agent.convertToLlm(messages);
      return { ok: true, value: { source: "runtime", systemPrompt: getCurrentSystemPrompt(projected),
        messages: projected, tools: getCurrentTools(projected), contextUsage: session.getContextUsage(), contextModel: session.model?.id } };
    });
  } catch (error) {
    return { ok: false, error: { code: "unavailable", message: `Cannot preview current model context: ${error instanceof Error ? error.message : String(error)}` } };
  }
}
