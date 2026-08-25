export const COMPACT_THRESHOLD_TOKENS = 250_000;

export default function stateCompactor(pi) {
  let compacting = false;

  pi.on("before_provider_request", (_event, ctx) => {
    const tokens = ctx.getContextUsage()?.tokens;
    if (compacting || tokens === null || tokens === undefined || tokens < COMPACT_THRESHOLD_TOKENS) return;

    compacting = true;
    const finished = () => {
      compacting = false;
    };
    ctx.compact({ onComplete: finished, onError: finished });
  });
}
