import { buildSessionProjection, convertToLlm, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { messageReference, parseMessageReference, type MessageIdentity, type MessageSender } from "./message-protocol";

type ModelMessage = ReturnType<typeof convertToLlm>[number];
type AddressedMessage = ModelMessage & { identity?: MessageIdentity };

function fingerprint(message: ModelMessage): string {
  return JSON.stringify([message.role, message.timestamp, message.content]);
}

function recordedIdentity(value: unknown): MessageIdentity | undefined {
  if (!value || typeof value !== "object") return;
  const identity = value as Record<string, unknown>;
  if (typeof identity.id !== "string" || !parseMessageReference(identity.id)
    || typeof identity.timestamp !== "number" || !Number.isFinite(identity.timestamp)) return;
  const sender = recordedSender(identity.sender);
  return sender ? { id: identity.id, timestamp: identity.timestamp, sender } : undefined;
}

function recordedSender(value: unknown): MessageSender | undefined {
  if (!value || typeof value !== "object") return;
  const sender = value as Record<string, unknown>;
  if (typeof sender.id !== "string" || !sender.id) return;
  return { id: sender.id, ...(typeof sender.name === "string" && sender.name ? { name: sender.name } : {}) };
}

export function identifyMessages(messages: ModelMessage[], ctx: ExtensionContext, sessionId: string, user: MessageSender, assistantName = "Assistant"): AddressedMessage[] {
  if (!ctx.sessionManager?.getBranch) return messages;
  const projection = buildSessionProjection(ctx.sessionManager.getBranch());
  const sources = projection.entries.flatMap(({ sourceEntry, messages }) =>
    convertToLlm(messages).map(message => ({ sourceEntry, message })));
  const candidates = sources.filter(({ sourceEntry, message }) =>
    (sourceEntry.type === "message" || sourceEntry.type === "custom_message")
    && (message.role === "user" || message.role === "assistant"));
  const aligned = messages.length === sources.length && messages.every((message, index) =>
    message.role === sources[index]!.message.role && message.timestamp === sources[index]!.message.timestamp);
  const byFingerprint = new Map<string, (typeof sources)[number] | undefined>();
  if (!aligned) for (const candidate of candidates) {
    const key = fingerprint(candidate.message);
    byFingerprint.set(key, byFingerprint.has(key) ? undefined : candidate);
  }
  const matching = aligned ? sources : messages.map(message => byFingerprint.get(fingerprint(message)));
  return messages.map((message, index) => {
    const source = matching[index];
    if (!source || (message.role !== "user" && message.role !== "assistant")) return message;
    const entry = source.sourceEntry;
    if (entry.type !== "message" && entry.type !== "custom_message") return message;
    const timestamp = source.message.timestamp;
    if (!Number.isFinite(timestamp)) return message;
    const sourceMetadata = entry.type === "message" ? entry.message as unknown as Record<string, unknown> : entry.details as Record<string, unknown> | undefined;
    const recorded = recordedIdentity(sourceMetadata?.identity);
    if (recorded) return { ...message, identity: recorded };
    const sender = recordedSender((sourceMetadata?.identity as { sender?: unknown } | undefined)?.sender)
      ?? recordedSender(sourceMetadata?.sender)
      ?? (entry.type === "message" ? (message.role === "user" ? user : { id: "assistant", name: assistantName }) : undefined);
    if (!sender) return message;
    return { ...message, identity: {
      id: messageReference({ transport: "pi", sessionId, messageId: entry.id }),
      timestamp,
      sender,
    } };
  });
}

export function modelVisibleMessages(messages: AddressedMessage[]): ModelMessage[] {
  return messages.flatMap(message => {
    if (!message.identity || (message.role !== "user" && message.role !== "assistant")) return [message];
    const { id, timestamp, sender } = message.identity;
    const label = `Message ID: ${JSON.stringify(id)}; sender: ${JSON.stringify(sender.name ?? sender.id)} (${JSON.stringify(sender.id)}); system time: ${new Date(timestamp).toISOString()}`;
    const header = `[${label}]\n`;
    if (message.role === "user") {
      if (typeof message.content === "string") return [{ ...message, content: header + message.content }];
      const content = [...message.content];
      const firstText = content.findIndex(block => block.type === "text");
      if (firstText < 0) content.unshift({ type: "text", text: header });
      else {
        const block = content[firstText]!;
        if (block.type === "text") content[firstText] = { ...block, text: header + block.text };
      }
      return [{ ...message, content }];
    }
    // Assistant text/thinking signatures and tool-call order belong to the provider.
    // A separate system update gives the model the address without touching them.
    return [{ role: "system", content: header.trimEnd(), timestamp }, message];
  });
}
