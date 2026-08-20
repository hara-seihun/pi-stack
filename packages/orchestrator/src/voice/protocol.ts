/**
 * Pure helpers for the GPT-Live data-channel protocol: the JSON events a
 * peer exchanges once a call is negotiated. Transport-agnostic — the same
 * events flow over a browser RTCDataChannel, a WebSocket relay, or a native
 * peer.
 */

export const MAX_CONTEXT_CHUNK_BYTES = 500;

export type RealtimeEvent = Record<string, unknown>;

export type ContextChannel = "speakable" | "commentary";

export interface DelegationCreated {
  readonly delegationId: string;
  readonly task: string;
}

export interface TurnTranscript {
  readonly role: "user" | "assistant";
  readonly transcript: string;
}

function record(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : null;
}

/** Split text on UTF-8 byte boundaries so no context event exceeds the protocol's chunk budget. */
export function utf8Chunks(value: string, maxBytes = MAX_CONTEXT_CHUNK_BYTES): string[] {
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let chunk = "";
  let bytes = 0;
  for (const character of value) {
    const size = encoder.encode(character).byteLength;
    if (chunk && bytes + size > maxBytes) {
      chunks.push(chunk);
      chunk = "";
      bytes = 0;
    }
    chunk += character;
    bytes += size;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

/** A `delegation.created` event: the voice model handing a task to the client agent. */
export function parseDelegationCreated(event: RealtimeEvent): DelegationCreated | null {
  if (event.type !== "delegation.created") return null;
  const item = record(event.item);
  const task = (Array.isArray(item?.content) ? item.content : [])
    .map(record)
    .filter((part) => part?.type === "input_text" && typeof part.text === "string")
    .map((part) => part!.text as string)
    .join("")
    .trim();
  const delegationId = typeof item?.id === "string" ? item.id : "";
  return delegationId && task ? { delegationId, task } : null;
}

/** A `turn.done` event carrying a finished user or assistant voice turn. */
export function parseTurnTranscript(event: RealtimeEvent): TurnTranscript | null {
  if (event.type !== "turn.done") return null;
  const turn = record(event.turn);
  const role = turn?.role;
  const transcript = typeof turn?.transcript === "string" ? turn.transcript.trim() : "";
  return (role === "user" || role === "assistant") && transcript ? { role, transcript } : null;
}

/**
 * Chunked context events. With a delegation id they answer or narrate that
 * delegation; without one they append to the session context.
 */
export function contextAppendEvents(
  text: string,
  channel: ContextChannel,
  delegationId?: string,
): RealtimeEvent[] {
  if (!text.trim()) return [];
  return utf8Chunks(text.trim()).map((part) =>
    delegationId
      ? {
          type: "delegation.context.append",
          delegation_item_id: delegationId,
          channel,
          content: [{ type: "input_text", text: part }],
        }
      : {
          type: "session.context.append",
          channel,
          content: [{ type: "input_text", text: part }],
        },
  );
}
