import { createParser } from "eventsource-parser";

export const IMAGE_MODELS = ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"] as const;
export const IMAGE_QUALITIES = ["auto", "low", "medium", "high", "xhigh", "max"] as const;
export const IMAGE_SIZES = ["auto", "1024x1024", "1536x1024", "1024x1536"] as const;
export const IMAGE_ROUTER_MODEL = "gpt-6-luna";
export const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export type ImageRequest = {
  prompt: string;
  model?: typeof IMAGE_MODELS[number];
  quality?: typeof IMAGE_QUALITIES[number];
  size?: typeof IMAGE_SIZES[number];
  images?: readonly string[];
};
export type ImageAuth = { kind: "codex" | "api"; headers: Headers };
export type ImageFailure = { kind: "http" | "protocol" | "cancelled" | "transport"; message: string; status?: number; retryAfterMs?: number };
export type GeneratedImage = { id: string; bytes: Buffer };
export type ImageResult = { ok: true; images: GeneratedImage[]; responseId: string; model: string; usage: unknown }
  | { ok: false; error: ImageFailure };
type ObjectValue = Record<string, any>;

export function imageRequestBody(request: ImageRequest) {
  return {
    model: IMAGE_ROUTER_MODEL, store: false, stream: true, instructions: "",
    input: [{ role: "user", content: [
      { type: "input_text", text: request.prompt },
      ...(request.images ?? []).map(image_url => ({ type: "input_image", image_url })),
    ] }],
    tools: [{ type: "image_generation", model: request.model ?? IMAGE_MODELS[0],
      action: request.images?.length ? "edit" : "generate", output_format: "png",
      quality: request.quality ?? "auto", size: request.size ?? "auto" }],
    tool_choice: { type: "image_generation" }, parallel_tool_calls: false,
  };
}

function failure(kind: ImageFailure["kind"], message: string): ImageResult {
  return { ok: false, error: { kind, message } };
}

export async function requestImage(request: ImageRequest, auth: ImageAuth, signal: AbortSignal, transport: (url: string, init: RequestInit) => Promise<Response> = fetch): Promise<ImageResult> {
  try {
    signal.throwIfAborted();
    const headers = new Headers(auth.headers);
    headers.set("Content-Type", "application/json");
    headers.set("Accept", "text/event-stream");
    if (auth.kind === "codex") {
      headers.set("originator", "pi");
      headers.set("OpenAI-Beta", "responses=experimental");
    }
    const response = await transport(auth.kind === "codex"
      ? "https://chatgpt.com/backend-api/codex/responses" : "https://api.openai.com/v1/responses", {
      method: "POST", headers, body: JSON.stringify(imageRequestBody(request)), signal,
    });
    if (!response.ok) {
      const retry = response.headers.get("retry-after");
      const seconds = Number(retry);
      const retryAfterMs = retry && Number.isFinite(seconds) ? seconds * 1000 : retry ? Date.parse(retry) - Date.now() : undefined;
      await response.body?.cancel();
      return { ok: false, error: { kind: "http", status: response.status,
        message: `OpenAI image generation returned HTTP ${response.status}. Request ID: ${response.headers.get("x-request-id") ?? "unavailable"}.`,
        retryAfterMs: retryAfterMs && retryAfterMs > 0 ? retryAfterMs : undefined } };
    }
    if (!response.body) return failure("protocol", "OpenAI returned no image response stream.");
    let completed: ObjectValue | undefined;
    let streamFailure: string | undefined;
    const items = new Map<string, ObjectValue>();
    const parser = createParser({
      maxBufferSize: 64 * 1024 * 1024,
      onEvent({ data }) {
        if (data === "[DONE]") return;
        const event = JSON.parse(data) as ObjectValue;
        if (event.type === "response.output_item.done" && event.item) items.set(event.item.id, event.item);
        if (event.type === "response.completed") completed = event.response;
        if (["error", "response.failed", "response.incomplete"].includes(event.type)) {
          streamFailure = String(event.error?.message ?? event.response?.error?.message
            ?? event.response?.incomplete_details?.reason ?? event.type).slice(0, 2000);
        }
      },
      onError(error) { throw error; },
    });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (!completed && !streamFailure) {
        const chunk = await reader.read();
        if (chunk.done) { parser.feed(decoder.decode()); break; }
        parser.feed(decoder.decode(chunk.value, { stream: true }));
      }
    } finally { try { await reader.cancel(); } finally { reader.releaseLock(); } }
    if (streamFailure) return failure("protocol", `OpenAI image generation failed: ${streamFailure}`);
    if (!completed) return failure("protocol", "Image stream ended without response.completed. No automatic retry was made.");
    for (const item of completed.output ?? []) items.set(item.id, item);
    const calls = [...items.values()].filter(item => item.type === "image_generation_call" && item.status === "completed");
    if (!calls.length) return failure("protocol", `No completed images. Response: ${completed.id ?? "unknown"}.`);
    const model = request.model ?? IMAGE_MODELS[0];
    const images: GeneratedImage[] = [];
    for (const call of calls) {
      if (call.model && call.model !== model) return failure("protocol", `OpenAI returned ${call.model} instead of ${model}.`);
      if (typeof call.result !== "string") return failure("protocol", `OpenAI returned no image payload for ${call.id}.`);
      const bytes = Buffer.from(call.result, "base64");
      if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return failure("protocol", `OpenAI returned an invalid PNG payload for ${call.id}.`);
      images.push({ id: String(call.id), bytes });
    }
    return { ok: true, images, responseId: String(completed.id), model, usage: completed.usage };
  } catch (error) {
    return failure(signal.aborted ? "cancelled" : "transport", signal.aborted
      ? "Image generation cancelled or exceeded its five-minute deadline. No automatic retry was made."
      : `Image generation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
