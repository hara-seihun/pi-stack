import {
  ORCHESTRATOR_CATALOG,
  catalogModel,
  type PlanUsageSnapshot,
} from "pi-orchestrator/api";

import type { PlanCard, PlanMetricRow } from "./protocol";

export type { PlanCard, PlanMetricRow };

function percent(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}

function pace(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  return ` (${value >= 0 ? "+" : ""}${percent(value)}%)`;
}

/** Pi Remote owns prose and card layout; model and meter semantics come from
 * the orchestrator catalog and read model. */
export function planCards(snapshot: PlanUsageSnapshot | null): PlanCard[] {
  return ORCHESTRATOR_CATALOG.plans.map((plan) => {
    const usage = snapshot?.plans[plan.id];
    const state = String(usage?.state ?? "loading");
    const rendered = plan.metrics.map((metric) => {
      const value = usage?.metrics[metric.id]?.percentLeft ?? null;
      const paceText = pace(usage?.metrics[metric.id]?.paceDelta);
      const cache = usage?.metrics[metric.id]?.cachePercent ?? null;
      const model = catalogModel(metric.model);
      if (!model) throw new Error(`Plan ${plan.id} names unknown model ${metric.model}`);
      return {
        id: metric.id,
        model: model.id,
        modelLabel: model.label,
        text: value === null ? "—" : `${percent(value)}%${paceText}`,
        cacheText: cache === null ? "" : `${percent(cache)}%`,
        description: `${metric.name ?? metric.label ?? plan.label} ${value === null ? "usage unavailable" : `${percent(value)}% remaining${paceText ? `, pace ${paceText.trim()}` : ""}`}${cache === null ? ", no calls in the last 24 hours" : `, ${percent(cache)}% of prompt tokens read from cache over the last 24 hours`}`,
      };
    });
    const planCount = usage?.planCount ?? 0;
    const checkedCount = usage?.checkedCount ?? 0;
    const coverage = state === "partial" && planCount > 0
      ? ` (measured on ${checkedCount} of ${planCount} plans)`
      : "";
    return {
      id: plan.id,
      label: plan.label,
      icon: plan.icon,
      state,
      text: `${rendered.map((metric, index) => `${plan.metrics[index]?.label ? `${plan.metrics[index].label} ` : ""}${metric.text}`).join(" · ")}${coverage ? "*" : ""}`,
      description: state === "loading"
        ? `${plan.label} plan usage loading`
        : rendered.every((metric) => metric.text.includes("—"))
          ? planCount > 0 ? `${plan.label} plan usage unavailable` : `No ${plan.label} plan configured`
          : `${plan.label}${coverage}: ${rendered.map((metric) => metric.description).join("; ")}`,
      metrics: rendered,
    };
  });
}
