import type { ResponseMetrics } from "../../server/protocol";

export function formatResponseMetrics(metrics: ResponseMetrics): string {
  const ttft = `${(metrics.ttftMs / 1_000).toFixed(1)} s to first token`;
  if (metrics.tokensPerSecond === null) return ttft;
  const rate = metrics.tokensPerSecond > 10
    ? Math.round(metrics.tokensPerSecond).toString()
    : metrics.tokensPerSecond.toFixed(1);
  return `${ttft} · ${rate} tok/s`;
}
