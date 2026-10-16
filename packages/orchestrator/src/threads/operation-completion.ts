import type { ImageContent } from "@earendil-works/pi-ai";
import type { PiEvent } from "./contracts.js";
import { parseNativeInputs, type NativeInput } from "./pi-input-batch.js";

export function operationCompletionInput(event: PiEvent): { ok: true; value: NativeInput } | { ok: false; error: string } {
  const outcome = event.outcome as { kind?: unknown; result?: { content?: unknown } } | undefined;
  if (!outcome || typeof outcome.kind !== "string" || !["complete", "failed", "cancelled", "timed_out", "uncertain"].includes(outcome.kind)
    || outcome.kind === "complete" && outcome.result === undefined) {
    return { ok: false, error: "Invalid tool operation outcome" };
  }
  let images: ImageContent[] | undefined;
  if (outcome.result !== undefined) {
    const content = outcome.result?.content;
    if (!Array.isArray(content) || content.some(part => !part || part.type !== "text" && part.type !== "image"
      || part.type === "text" && typeof part.text !== "string")) {
      return { ok: false, error: "Invalid tool operation result content" };
    }
    images = content.filter(part => part.type === "image");
  }
  const parsed = parseNativeInputs([{ workId: event.workId, message: event.message, inputOrigin: "machine",
    ...(images?.length ? { images } : {}) }]);
  return parsed.ok ? { ok: true, value: parsed.value[0]! } : parsed;
}
