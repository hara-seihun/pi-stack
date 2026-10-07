import type { ContextUsage } from "./protocol";

type Capture = { document: string };
const captures = new WeakMap<Capture, { model?: string; usage?: ContextUsage }>();

export function capturedContextUsage(capture: Capture | null, selectedModel: string): ContextUsage | undefined {
  if (!capture) return undefined;
  let cached = captures.get(capture);
  if (!cached) {
    const context = JSON.parse(capture.document);
    const usage = context.contextUsage;
    cached = { model: context.contextModel };
    if (usage && Number.isFinite(usage.contextWindow) && usage.contextWindow > 0
      && (usage.tokens === null || (Number.isFinite(usage.tokens) && usage.tokens >= 0))
      && (usage.percent === null || (Number.isFinite(usage.percent) && usage.percent >= 0))
      && (usage.tokens === null) === (usage.percent === null)) {
      cached.usage = { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent };
    }
    captures.set(capture, cached);
  }
  const modelId = selectedModel.slice(selectedModel.indexOf("/") + 1);
  return cached.model === modelId ? cached.usage : undefined;
}
