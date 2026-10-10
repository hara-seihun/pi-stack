import { useEffect, useState } from "react";
import { API } from "../../../../server/api";
import { FEATURES, type FeatureUsageSummary } from "../../../../shared/feature-usage";
import { api } from "../../client";
import { featureCollectionError } from "../../feature-usage";
import { machineRow } from "./MachineScreen";
import type { MachineRow } from "./rows";

type View = { state: "loading" } | { state: "ready"; summary: FeatureUsageSummary } | { state: "error"; message: string };
export function useFeatureUsageRows(): MachineRow[] {
  const [view, setView] = useState<View>({ state: "loading" });
  const [gap, setGap] = useState(featureCollectionError);
  useEffect(() => {
    let active = true;
    setView({ state: "loading" });
    void api("GET", API.featureUsage.path()).then(result => {
      if (active) setView(result.ok ? { state: "ready", summary: result.value } : { state: "error", message: result.error.message });
    }, cause => { if (active) setView({ state: "error", message: String(cause) }); });
    const changed = () => setGap(featureCollectionError());
    window.addEventListener("pi-feature-usage-error", changed);
    return () => { active = false; window.removeEventListener("pi-feature-usage-error", changed); };
  }, []);
  const children: MachineRow[] = view.state === "ready" ? view.summary.features.map(feature => {
    const uses = feature.observations.reduce((n, item) => n + item.uses, 0);
    const recent = feature.observations.reduce((n, item) => n + item.last7Days, 0);
    return machineRow(feature.id, 0, FEATURES[feature.id].label, `${recent} this week · ${uses} total`, FEATURES[feature.id].coverage,
      feature.observations.map(item => machineRow(item.actor, 0, item.actor, `${item.uses} uses`, item.state === null ? "State not observed" : `${item.state.value} · ${new Date(item.state.observedAt).toLocaleString()}`)));
  }) : [];
  const row: MachineRow = { ...machineRow("features", view.state === "error" || gap ? 100 : 10, "Feature use", view.state === "loading" ? "Loading…" : view.state === "error" ? view.message : `${view.summary.features.length} features`, gap || (view.state === "ready" ? `Collection began ${new Date(view.summary.since).toLocaleString()} · ${view.summary.retentionDays} days retained` : null), children), tone: view.state === "error" || gap ? "warning" : "normal", action: null };
  return [row];
}
