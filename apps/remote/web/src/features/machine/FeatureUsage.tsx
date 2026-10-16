import { useEffect, useState } from "react";
import { API } from "../../../../server/api";
import { FEATURES, type FeatureUsageSummary } from "../../../../shared/feature-usage";
import { api } from "../../client";
import { featureCollectionError } from "../../feature-usage";

type View = { state: "loading" } | { state: "ready"; summary: FeatureUsageSummary } | { state: "error"; message: string };
export function FeatureUsagePanel() {
  const [view, setView] = useState<View>({ state: "loading" });
  const [gap, setGap] = useState(featureCollectionError);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setView({ state: "loading" });
    void api("GET", API.featureUsage.path()).then(result => {
      if (active) setView(result.ok ? { state: "ready", summary: result.value } : { state: "error", message: result.error.message });
    }, cause => { if (active) setView({ state: "error", message: String(cause) }); });
    const changed = () => setGap(featureCollectionError());
    window.addEventListener("pi-feature-usage-error", changed);
    return () => { active = false; window.removeEventListener("pi-feature-usage-error", changed); };
  }, [revision]);
  return <section className="machine-card">
    <h2>Feature use</h2>
    <p className="machine-secondary">Your own accepted actions and screen opens, not background refreshes. No message contents, names or file paths are logged.</p>
    {gap && <p role="status">{gap}</p>}
    {view.state === "loading" ? <p>Loading usage…</p> : view.state === "error" ? <p role="alert">{view.message}</p> : <>
      <p className="machine-secondary">Collection began {new Date(view.summary.since).toLocaleString()}. Daily counts retained for 90 days. Zero means no recorded use within this coverage, not proof of disuse before collection.</p>
      {view.summary.features.map(feature => {
        const uses = feature.observations.reduce((n, item) => n + item.uses, 0);
        const recent = feature.observations.reduce((n, item) => n + item.last7Days, 0);
        const previous = feature.observations.reduce((n, item) => n + item.previous30Days, 0);
        const last = feature.observations.reduce<number | null>((at, item) => item.lastUsedAt === null ? at : at === null ? item.lastUsedAt : Math.max(at, item.lastUsedAt), null);
        return <details key={feature.id} className="machine-plan-row">
          <summary>{FEATURES[feature.id].label} · {recent} this week · {uses} total</summary>
          <p>{FEATURES[feature.id].coverage}. Previous 30 days before this week: {previous}. Last used: {last === null ? "not observed" : new Date(last).toLocaleString()}.</p>
          {feature.observations.map(item => <p key={item.actor}>{item.actor}: {item.uses} uses; state {item.state === null ? "not observed" : `${item.state.value} (observed ${new Date(item.state.observedAt).toLocaleString()})`}</p>)}
        </details>;
      })}
    </>}
    <button type="button" onClick={() => setRevision(value => value + 1)}>Refresh usage</button>
  </section>;
}
