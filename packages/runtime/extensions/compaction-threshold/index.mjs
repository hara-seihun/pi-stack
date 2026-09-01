export const COMPACT_THRESHOLDS = Object.freeze({
  default: 250_000,
  sol: 250_000,
  fable: 500_000,
  opus: 500_000,
});
export const CONTINUATION_MESSAGE = "Your context was compacted, you now have tons of room to continue what you were doing ^-^";

export function thresholdForModel(modelId) {
  const id = modelId?.toLowerCase() ?? "";
  if (id.includes("claude-fable-")) return COMPACT_THRESHOLDS.fable;
  if (id.includes("claude-opus-")) return COMPACT_THRESHOLDS.opus;
  if (/(?:^|[-/])sol(?:$|[-.])/.test(id)) return COMPACT_THRESHOLDS.sol;
  return COMPACT_THRESHOLDS.default;
}

export default function compactionThreshold(pi) {
  let compacting = false;

  pi.on("before_provider_request", (_event, ctx) => {
    const tokens = ctx.getContextUsage()?.tokens;
    const threshold = thresholdForModel(ctx.model?.id);
    if (compacting || tokens === null || tokens === undefined || tokens < threshold) return;

    compacting = true;
    ctx.compact({
      onComplete: () => {
        compacting = false;
        pi.sendMessage(
          {
            customType: "compaction-threshold",
            content: CONTINUATION_MESSAGE,
            display: false,
          },
          { triggerTurn: true },
        );
      },
      onError: () => {
        compacting = false;
      },
    });
  });
}
