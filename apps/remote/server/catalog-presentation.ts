import {
  ORCHESTRATOR_CATALOG,
  catalogMeter,
  catalogModel,
  type PlanUsageSnapshot,
} from "pi-orchestrator/api";

import type { PlanAccountRow, PlanCard, PlanMetricRow } from "./protocol";

export type { PlanAccountRow, PlanCard, PlanMetricRow };

function percent(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}

function pace(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  if (value === 0) return " · on pace";
  return ` · ${percent(Math.abs(value))}% ${value > 0 ? "ahead of" : "behind"} pace`;
}

function quotaWindows(meterIds: readonly string[]): string {
  const windows = [...new Set(meterIds.map((id) => catalogMeter(id)?.windowHours).filter((hours): hours is number => hours !== undefined))];
  const labels = windows.map((hours) => hours % 24 === 0 ? `${hours / 24}-day` : `${hours}-hour`);
  if (labels.length === 0) return "Quota";
  if (labels.length === 1) return `${labels[0]} quota`;
  return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)} quotas`;
}

function quotaDescription(name: string | undefined, modelLabel: string, meterIds: readonly string[]): string {
  const escapedModel = modelLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const scope = name
    ?.replace(/\bweekly\b/gi, "")
    .replace(new RegExp(`\\bincluding\\s+${escapedModel}\\b`, "gi"), "")
    .replace(new RegExp(`\\b${escapedModel}\\b`, "gi"), "")
    .replace(/^\s*,\s*|\s*,\s*$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .toLowerCase();
  const windows = quotaWindows(meterIds);
  return scope ? `${windows} · ${scope}` : windows;
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
        text: value === null ? "—" : `${percent(value)}% remaining${paceText}`,
        cacheText: cache === null ? "" : `${percent(cache)}%`,
        description: quotaDescription(metric.name, model.label, metric.meters),
        accounts: usage?.metrics[metric.id]?.accounts.map((account) => ({ ...account })) ?? [],
      };
    });
    const planCount = usage?.planCount ?? 0;
    const checkedCount = usage?.checkedCount ?? 0;
    const description = state === "loading"
      ? "Usage loading"
      : rendered.every((metric) => metric.text === "—")
        ? planCount > 0 ? "Usage unavailable" : "No plan configured"
        : state === "partial"
          ? `${checkedCount} of ${planCount} plans measured`
          : "";
    return {
      id: plan.id,
      label: plan.label,
      icon: plan.icon,
      state,
      text: rendered.map((metric) => metric.text).join(" · "),
      description,
      metrics: rendered,
    };
  });
}
