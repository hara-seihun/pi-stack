export type SignatureChannel =
  | { kind: "channel"; channel: "narration" | "thinking" }
  | { kind: "unrecognized" };

export function anthropicSignatureChannel(signature: unknown): SignatureChannel;
export function anthropicNarrationText(block: Record<string, unknown>): { type: "text"; text: string; textSignature: string } | null;
export function anthropicNarrationReplaySignature(value: unknown): string | null;
export function projectAnthropicNarrationMessage(message: Record<string, unknown>): Record<string, unknown>;
