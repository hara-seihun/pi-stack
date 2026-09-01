import { buildSessionContext, convertToLlm, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { contextSplice, sha256 } from "./sync";

type ModelMessage = ReturnType<typeof convertToLlm>[number];
type ModelTool = { name: string; description: string; parameters: unknown };
type ModelContext = { systemPrompt: string; tools: ModelTool[]; messages: ModelMessage[] };

export default function contextMirror(pi: ExtensionAPI) {
  const sessionId = process.env.PI_REMOTE_SESSION_ID;
  const server = process.env.PI_REMOTE_SERVER_URL;
  if (!sessionId || !server) return;

  let context: ModelContext | null = null;
  let baseMessages: ModelMessage[] = [];
  let capturedAt = 0;
  let pending: { capturedAt: number; context: ModelContext; compact: boolean; replacement?: "compaction" } | null = null;
  let publishedDocument: string | null = null;
  let draining: Promise<void> | null = null;

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
        const document = JSON.stringify(snapshot.context);
        let response: Response;
        if (publishedDocument !== null && !snapshot.compact) {
          response = await fetch(`${server}/v1/sessions/${sessionId}/context`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ capturedAt: snapshot.capturedAt, splice: contextSplice(publishedDocument, document) }),
          });
          if (response.status === 409) {
            response = await fetch(`${server}/v1/sessions/${sessionId}/context`, {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                capturedAt: snapshot.capturedAt,
                context: snapshot.context,
                replacement: snapshot.replacement,
              }),
            });
          }
        } else {
          response = await fetch(`${server}/v1/sessions/${sessionId}/context`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              capturedAt: snapshot.capturedAt,
              context: snapshot.context,
              replacement: snapshot.replacement,
            }),
          });
        }
        if (!response.ok) throw new Error(await response.text() || `Context mirror failed (${response.status})`);
        const result = await response.json() as { hash?: string };
        if (result.hash && result.hash !== sha256(document)) throw new Error("Context mirror acknowledgement hash does not match");
        publishedDocument = document;
      }
    })().finally(() => {
      draining = null;
      if (pending) {
        void drain().catch((error) => console.error(
          `Pi Remote context mirror failed: ${error instanceof Error ? error.message : error}`,
        ));
      }
    });
    return draining;
  };

  const publish = (next: ModelContext, compact = false, replacement?: "compaction") => {
    pending = {
      capturedAt: nextCaptureTime(),
      context: next,
      compact: compact || pending?.compact === true,
      replacement: replacement ?? pending?.replacement,
    };
    return drain();
  };

  const publishCurrent = async (compact = false, replacement?: "compaction") => {
    if (!context) return;
    await publish(context, compact, replacement);
  };

  const replaceContext = async (
    messages: Parameters<typeof convertToLlm>[0],
    ctx: ExtensionContext,
    replacement?: "compaction",
  ) => {
    const active = new Set(pi.getActiveTools());
    baseMessages = convertToLlm(messages);
    context = {
      systemPrompt: ctx.getSystemPrompt(),
      tools: pi.getAllTools()
        .filter((tool) => active.has(tool.name))
        .map(({ name, description, parameters }) => ({ name, description, parameters })),
      messages: baseMessages,
    };
    await publishCurrent(true, replacement);
  };

  const replaceContextFromSession = async (ctx: ExtensionContext, replacement?: "compaction") => {
    const session = buildSessionContext(ctx.sessionManager.getBranch());
    await replaceContext(session.messages, ctx, replacement);
  };

  pi.on("context", async (event, ctx) => {
    await replaceContext(event.messages, ctx);
  });

  pi.on("session_start", async (_event, ctx) => {
    await replaceContextFromSession(ctx);
  });

  pi.on("session_compact", async (_event, ctx) => {
    await replaceContextFromSession(ctx, "compaction");
  });

  pi.on("session_tree", async (_event, ctx) => {
    await replaceContextFromSession(ctx);
  });

  pi.on("message_end", async (event) => {
    if (!context || (event.message.role !== "assistant" && event.message.role !== "toolResult")) return;
    baseMessages = [...baseMessages, ...convertToLlm([event.message])];
    context = { ...context, messages: baseMessages };
    await publishCurrent(true);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await replaceContextFromSession(ctx);
    if (draining) await draining;
  });
}
