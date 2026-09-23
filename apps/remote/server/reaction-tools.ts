import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { API } from "./api";
import type { MessageReaction, ReactionRequest } from "./message-protocol";
import { sessionEnvironment } from "./session-environment";

type ReactionResult = { ok: true; reactions: MessageReaction[] } | { ok: false; error: { code: string; message: string } };

export function registerReactionTools(pi: ExtensionAPI): void {
  const environment = sessionEnvironment();
  const sessionId = environment.PI_REMOTE_SESSION_ID;
  const server = environment.PI_REMOTE_SERVER_URL;
  if (!sessionId || !server) return;
  pi.registerTool({
    name: "message_react",
    label: "React to a message",
    description: "Add or remove an emoji reaction on a specific message. Use the Message ID in the conversation context. For Slack thread replies, pass threadTs when needed. A successful result confirms the reaction; a network timeout leaves the outcome unconfirmed.",
    parameters: Type.Object({
      messageId: Type.String({ description: "Exact Message ID from the conversation." }),
      emoji: Type.String({ description: "Emoji reaction to add or remove." }),
      remove: Type.Optional(Type.Boolean({ description: "Remove your reaction instead of adding it." })),
      threadTs: Type.Optional(Type.String({ description: "Slack thread timestamp, if targeting a thread reply." })),
    }),
    async execute(_id, params: ReactionRequest, signal): Promise<{ content: [{ type: "text"; text: string }]; details: ReactionResult }> {
      let result: ReactionResult;
      try {
        const response = await fetch(new URL(API.sessionReaction.path({ sessionId }), server), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(params),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(55_000)]) : AbortSignal.timeout(55_000),
        });
        const body = await response.json() as ReactionResult;
        result = body?.ok === true && response.ok ? body
          : body?.ok === false ? body
          : { ok: false, error: { code: `HTTP_${response.status}`, message: `Reaction request failed with HTTP ${response.status}` } };
      } catch (cause) {
        result = { ok: false, error: { code: "OUTCOME_UNCONFIRMED", message: `The reaction outcome is unconfirmed: ${cause instanceof Error ? cause.message : String(cause)}` } };
      }
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });
}
