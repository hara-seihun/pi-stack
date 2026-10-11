import type { CoreResult } from "./config.js";

type ComponentHealth = "ready" | "failed" | "disabled";
export type RootReconciliationHealth =
  | { state: "disabled" | "ready" | "failed" }
  | { state: "delivery-degraded"; retainedDeliveryErrors: number };
export type CoreReconciliationHealth =
  | { state: "pending" }
  | { state: "observed"; provider: ComponentHealth; duties: "ready" | "failed"; root: RootReconciliationHealth };

export function observeCoreReconciliation(
  provider: PromiseSettledResult<void | undefined>,
  root: PromiseSettledResult<{ errors: number } | undefined>,
  duties: PromiseSettledResult<CoreResult<void>>,
  configured: { provider: boolean; root: boolean },
): CoreReconciliationHealth {
  let rootHealth: RootReconciliationHealth;
  if (!configured.root) rootHealth = { state: "disabled" };
  else if (root.status === "rejected" || !root.value || !Number.isSafeInteger(root.value.errors) || root.value.errors < 0) rootHealth = { state: "failed" };
  else rootHealth = root.value.errors === 0 ? { state: "ready" } : { state: "delivery-degraded", retainedDeliveryErrors: root.value.errors };
  return {
    state: "observed",
    provider: !configured.provider ? "disabled" : provider.status === "fulfilled" ? "ready" : "failed",
    duties: duties.status === "fulfilled" && duties.value.ok ? "ready" : "failed",
    root: rootHealth,
  };
}

export function coreReadiness(started: boolean, stopping: boolean, reconciliation: CoreReconciliationHealth): { ready: boolean; degraded: boolean } {
  if (!started || stopping || reconciliation.state === "pending") return { ready: false, degraded: false };
  return {
    ready: reconciliation.provider !== "failed" && reconciliation.duties !== "failed" && reconciliation.root.state !== "failed",
    degraded: reconciliation.root.state === "delivery-degraded",
  };
}
