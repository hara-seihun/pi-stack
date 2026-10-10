export type RetirementEdge =
  | { edge: string; state: "closed"; elapsedMs: number }
  | { edge: string; state: "retained"; elapsedMs: number }
  | { edge: string; state: "error"; elapsedMs: number; error: string };
export type ControllerRetirement = { state: "closed" | "retained"; edges: RetirementEdge[] };

/** The deadline retires only the controller, never the independent execution owner. */
export async function retireController(
  edges: { edge: string; close: () => Promise<void> }[],
  budgetMs: number,
  observe: (event: { edge: string; state: "started" } | RetirementEdge) => void,
): Promise<ControllerRetirement> {
  if (!Number.isSafeInteger(budgetMs) || budgetMs <= 0) throw new Error("Controller retirement requires a positive budget");
  const results = await Promise.all(edges.map(({ edge, close }) => new Promise<RetirementEdge>(resolve => {
    const start = Date.now();
    observe({ edge, state: "started" });
    let settled = false;
    const finish = (result: RetirementEdge) => {
      if (settled) return;
      settled = true; clearTimeout(timer); observe(result); resolve(result);
    };
    const timer = setTimeout(() => finish({ edge, state: "retained", elapsedMs: Date.now() - start }), budgetMs);
    void Promise.resolve().then(close).then(
      () => finish({ edge, state: "closed", elapsedMs: Date.now() - start }),
      cause => finish({ edge, state: "error", elapsedMs: Date.now() - start, error: String(cause) }),
    );
  })));
  return { state: results.every(edge => edge.state === "closed") ? "closed" : "retained", edges: results };
}
