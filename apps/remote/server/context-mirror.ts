import { convertToLlm, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ModelMessage = ReturnType<typeof convertToLlm>[number];
type ModelTool = { name: string; description: string; parameters: unknown };
type ModelContext = { systemPrompt: string; tools: ModelTool[]; messages: ModelMessage[] };

const UPDATE_INTERVAL_MS = 1_000;

export default function contextMirror(pi: ExtensionAPI) {
  const sessionId = process.env.PI_REMOTE_SESSION_ID;
  const server = process.env.PI_REMOTE_SERVER_URL;
  if (!sessionId || !server) return;

  let context: ModelContext | null = null;
  let baseMessages: ModelMessage[] = [];
  let capturedAt = 0;
  let pending: { capturedAt: number; context: ModelContext } | null = null;
  let draining: Promise<void> | null = null;
  let updateTimer: ReturnType<typeof setTimeout> | null = null;

  const nextCaptureTime = () => {
    capturedAt = Math.max(Date.now(), capturedAt + 1);
    return capturedAt;
  };

  const drain = () => {
    if (draining) return draining;
    draining = (async () => {
      while (pending) {
        const snapshot = pending;
        pending = null;
        const response = await fetch(`${server}/v1/sessions/${sessionId}/context`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(snapshot),
        });
        if (!response.ok) throw new Error(await response.text() || `Context mirror failed (${response.status})`);
      }
    })().finally(() => { draining = null; });
    return draining;
  };

  const publish = (next: ModelContext) => {
    pending = { capturedAt: nextCaptureTime(), context: next };
    return drain();
  };

  const publishCurrent = async () => {
    if (!context) return;
    await publish(context);
  };

  const scheduleCurrent = () => {
    if (updateTimer || !context) return;
    updateTimer = setTimeout(() => {
      updateTimer = null;
      void publishCurrent().catch((error) => console.error(`Pi Remote context mirror failed: ${error instanceof Error ? error.message : error}`));
    }, UPDATE_INTERVAL_MS);
  };

  pi.on("context", async (event, ctx) => {
    const active = new Set(pi.getActiveTools());
    baseMessages = convertToLlm(event.messages);
    context = {
      systemPrompt: ctx.getSystemPrompt(),
      tools: pi.getAllTools()
        .filter((tool) => active.has(tool.name))
        .map(({ name, description, parameters }) => ({ name, description, parameters })),
      messages: baseMessages,
    };
    if (updateTimer) {
      clearTimeout(updateTimer);
      updateTimer = null;
    }
    await publishCurrent();
  });

  pi.on("message_update", (event) => {
    if (!context || event.message.role !== "assistant") return;
    context = { ...context, messages: [...baseMessages, ...convertToLlm([event.message])] };
    scheduleCurrent();
  });

  pi.on("message_end", async (event) => {
    if (!context || (event.message.role !== "assistant" && event.message.role !== "toolResult")) return;
    baseMessages = [...baseMessages, ...convertToLlm([event.message])];
    context = { ...context, messages: baseMessages };
    if (updateTimer) {
      clearTimeout(updateTimer);
      updateTimer = null;
    }
    await publishCurrent();
  });

  pi.on("session_shutdown", async () => {
    if (updateTimer) {
      clearTimeout(updateTimer);
      updateTimer = null;
    }
    if (context) await publishCurrent();
    if (draining) await draining;
  });
}
