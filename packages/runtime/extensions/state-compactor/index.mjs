export const COMPACT_THRESHOLD_TOKENS = 250_000;
export const CONTINUATION_MESSAGE = "Your context was compacted, you now have tons of room to continue what you were doing ^-^";

export default function stateCompactor(pi) {
  let compacting = false;

  pi.on("before_provider_request", (_event, ctx) => {
    const tokens = ctx.getContextUsage()?.tokens;
    if (compacting || tokens === null || tokens === undefined || tokens < COMPACT_THRESHOLD_TOKENS) return;

    compacting = true;
    const finished = () => {
      compacting = false;
    };
    ctx.compact({
      onComplete: () => {
        finished();
        pi.sendMessage(
          {
            customType: "state-compactor",
            content: CONTINUATION_MESSAGE,
            display: false,
          },
          { triggerTurn: true },
        );
      },
      onError: finished,
    });
  });
}
