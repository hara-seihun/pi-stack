import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ProviderManifestModel {
  id: string;
  provider: string;
  model: string;
  thinking: string;
  label: string;
  aliases: string[];
}

export interface ProviderManifestMetric {
  id: string;
  label?: string;
  name?: string;
  field: string;
  paceField?: string;
}

export interface ProviderManifestPlan {
  id: string;
  label: string;
  icon: string;
  metrics: ProviderManifestMetric[];
}

export interface ProviderManifest {
  version: number;
  models: ProviderManifestModel[];
  agentOrder: string[];
  plans: ProviderManifestPlan[];
}

export interface PlanCard {
  id: string;
  label: string;
  icon: string;
  state: string;
  text: string;
  description: string;
}

// Pi Remote presentation custody: model→agent-type labels and plan-card
// definitions. Formerly shared with the predecessor orchestrator's
// providers.json; the launch system no longer consumes it.
const DEFAULT_MANIFEST = join(import.meta.dir, "provider-manifest.json");

export function loadProviderManifest(path = process.env.PI_REMOTE_PROVIDER_MANIFEST ?? DEFAULT_MANIFEST): ProviderManifest {
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (manifest?.version !== 1 || !Array.isArray(manifest.models) || !Array.isArray(manifest.agentOrder) ||
      !Array.isArray(manifest.plans)) throw new Error("Invalid provider manifest");
  return manifest;
}

export function manifestAgentType(manifest: ProviderManifest, raw: string): { key: string; label: string } {
  const value = raw.toLowerCase();
  const match = manifest.models.find((model) => model.model.toLowerCase() === value ||
    value.includes(model.model.toLowerCase()) || model.aliases.some((alias) => value === alias.toLowerCase() || value.includes(alias.toLowerCase())));
  if (match) return { key: match.id, label: match.label };
  const bare = raw.split("/").at(-1)?.split(":")[0] || "unknown";
  return { key: bare.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "unknown", label: bare.toUpperCase() };
}

function percent(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}

function pace(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  return ` (${value >= 0 ? "+" : ""}${percent(value)}%)`;
}

export function manifestPlanCards(manifest: ProviderManifest, snapshot: Record<string, any>): PlanCard[] {
  return manifest.plans.map((plan) => {
    const usage = snapshot?.[plan.id];
    const state = String(usage?.state ?? "loading");
    const rendered = plan.metrics.map((metric) => {
      const raw = usage?.[metric.field];
      const value = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
      const paceText = metric.paceField ? pace(usage?.[metric.paceField]) : "";
      return {
        text: `${metric.label ? `${metric.label} ` : ""}${value === null ? "—" : `${percent(value)}%${paceText}`}`,
        description: `${metric.name ?? metric.label ?? plan.label} ${value === null ? "usage unavailable" : `${percent(value)}% remaining${paceText ? `, pace ${paceText.trim()}` : ""}`}`,
      };
    });
    const planCount = Number(usage?.planCount ?? 0);
    const checkedCount = Number(usage?.checkedCount ?? 0);
    // A figure averaged over some of the accounts is not the fleet's figure.
    // Say how many plans it covers whenever that is fewer than all of them.
    const coverage = state === "partial" && planCount > 0 ? ` (measured on ${checkedCount} of ${planCount} plans)` : "";
    return {
      id: plan.id,
      label: plan.label,
      icon: plan.icon,
      state,
      text: `${rendered.map((metric) => metric.text).join(" · ")}${coverage ? "*" : ""}`,
      description: state === "loading"
        ? `${plan.label} plan usage loading`
        : rendered.every((metric) => metric.text.includes("—"))
          ? planCount > 0 ? `${plan.label} plan usage unavailable` : `No ${plan.label} plan configured`
          : `${plan.label}${coverage}: ${rendered.map((metric) => metric.description).join("; ")}`,
    };
  });
}
