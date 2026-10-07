import { useEffect, useState } from "react";
import type { LifeCoverage } from "kenan-memory/life-contract";
import { API } from "../../server/api";
import type { NeedsYouItem, NeedsYouProjection } from "../../shared/needs-you";
import { piFetch } from "./client";
import { formatRoute } from "./app/routes";
import "./needs-you.css";

type Resource = { state: "loading" } | { state: "ready"; value: NeedsYouProjection } | { state: "failed"; error: string };
const labels: Record<NeedsYouItem["kind"], string> = { question: "Question", decision: "Decision", "missing-fact": "Only you know", "person-only-action": "Only you can do", commitment: "Your commitment" };

function timestamp(value: string, zone: string): string {
  try { return `${new Date(value).toLocaleString(undefined, { timeZone: zone, dateStyle: "medium", timeStyle: "short" })} · ${zone}`; }
  catch { return `Invalid time or timezone: ${value} · ${zone}`; }
}
function coverageStatus(coverage: LifeCoverage, now: number): string {
  const value = coverage.value;
  if (value.error !== null) return "Error";
  if (value.state === "excluded") return "Excluded";
  if (value.state === "inaccessible") return "Unavailable";
  if (value.reconciledAt === null) return "Not reconciled";
  if (value.freshUntil === null) return "Freshness unknown";
  if (Date.parse(value.freshUntil) <= now) return "Stale";
  return value.state === "partial" ? "Partial" : "Current";
}

export function NeedsYouScreen({ version }: { version: number }) {
  const [resource, setResource] = useState<Resource>({ state: "loading" });
  const [attempt, retry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setResource({ state: "loading" });
    void piFetch(API.needsYou.path(), { method: API.needsYou.method, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]), cache: "no-store" }).then(async response => {
      if (!response.ok) throw new Error(`Needs you returned HTTP ${response.status}`);
      return await response.json() as NeedsYouProjection;
    }).then((value: NeedsYouProjection) => {
      if (!controller.signal.aborted) setResource({ state: "ready", value });
    }, cause => {
      if (!controller.signal.aborted) setResource({ state: "failed", error: cause instanceof Error ? cause.message : String(cause) });
    });
    return () => controller.abort();
  }, [version, attempt]);
  const view = resource.state === "ready" ? resource.value : null;
  return <section className="needs-you-screen" aria-label="Needs you">
    <header><div><h1>Needs you</h1><p>Decisions, missing facts and actions that need you. Kenan keeps the rest.</p></div>
      <button type="button" disabled={resource.state === "loading"} onClick={() => retry(value => value + 1)}>Refresh view</button>
    </header>
    {resource.state === "loading" && <p role="status">Loading your sources…</p>}
    {resource.state === "failed" && <p className="needs-you-error" role="alert">Could not load Needs you. {resource.error}</p>}
    {view && <>
      {view.life.state === "failed" && <p className="needs-you-error" role="alert">Life model unavailable: {view.life.error}. Questions below are still from their original owners.</p>}
      {view.questions.state === "partial" && <details className="needs-you-error"><summary>Question coverage is incomplete</summary><ul>{view.questions.errors.map((error, i) => <li key={i}>{error}</li>)}</ul></details>}
      {view.items.length === 0 && <p className="needs-you-empty">No items in the available sources need you. Coverage below shows what has and hasn't been checked.</p>}
      <ol className="needs-you-items">{view.items.map(item => <li key={item.id}>
        <span className="needs-you-kind">{labels[item.kind]}</span><h2>{item.title}</h2>
        <dl><div><dt>Consequence</dt><dd>{item.consequence === null ? "Unknown — not recorded" : item.consequence}</dd></div>
          <div><dt>Required by</dt><dd>{item.deadline === null ? "Unknown — no deadline recorded" : <time dateTime={item.deadline.at}>{timestamp(item.deadline.at, item.deadline.timeZone)}</time>}</dd></div>
          <div><dt>Kenan recommends</dt><dd>{item.recommendation === null ? "Unknown — no recommendation recorded" : item.recommendation}</dd></div>
          {item.nextAction !== null && <div><dt>Next action</dt><dd>{item.nextAction}</dd></div>}
        </dl>
        {item.location !== null ? <a className="needs-you-open" href={formatRoute({ tab: "chats", chat: `ai:${item.location.threadId}`, panel: null, ...(item.location.questionId === null ? {} : { questionId: item.location.questionId }) })}>{item.location.questionId !== null ? "Answer in original conversation" : "Open source conversation"}</a>
          : <p className="needs-you-muted">Original conversation location not available</p>}
      </li>)}</ol>
      <section className="needs-you-coverage" aria-label="Coverage"><h2>What Kenan is carrying</h2>
        <p className="needs-you-muted">View read {timestamp(view.readAt, "UTC")}. Refreshing this view does not reconcile your life.</p>
        <h3>Life sources</h3>
        {view.life.state === "ready" && (view.life.value.coverage.length === 0 ? <p>No source coverage recorded. Last reconciliation unknown.</p> : <ul>{view.life.value.coverage.map(coverage => <li key={coverage.id}>
          <strong>{coverage.value.source}</strong><span className="needs-you-status">{coverageStatus(coverage, Date.now())}</span>
          <p>Last reconciled: {coverage.value.reconciledAt === null ? "Unknown — no reconciliation recorded" : timestamp(coverage.value.reconciledAt, "UTC")}</p>
          <p>Last source check: {timestamp(coverage.value.checkedAt, "UTC")}</p>
          {coverage.value.detail !== null && <p>{coverage.value.detail}</p>}{coverage.value.error !== null && <p className="needs-you-error">{coverage.value.error}</p>}
        </li>)}</ul>)}
        <h3>Watch coverage</h3>
        {view.watch.state === "failed" ? <p className="needs-you-error">Unavailable: {view.watch.error}</p> : <><p>{view.watch.value.count} conditions watched by Kenan — not tasks for you.</p>
          <p>Last actual check: unknown — the scheduler does not record a reconciliation receipt.</p>
          <p>Next scheduled due: {view.watch.value.nextDueAt === null ? "No watch items" : timestamp(new Date(view.watch.value.nextDueAt).toISOString(), "UTC")}. Scheduling is not evidence of a completed check.</p></>}
      </section>
      <details className="needs-you-policy"><summary>Your delegation policy</summary>
        {view.policy.state === "failed" ? <p className="needs-you-error">Policy unavailable: {view.policy.error}</p>
          : view.policy.value === null ? <p>No standing policy recorded. Ask Kenan in your own conversation to set one.</p> : <>
            <p>Revision {view.policy.value.revision} · {view.policy.value.value.status}</p>
            <dl><div><dt>Delegation</dt><dd>{view.policy.value.value.delegation}</dd></div>
              <div><dt>Domains</dt><dd>{view.policy.value.value.domains.length ? view.policy.value.value.domains.join(", ") : "None recorded"}</dd></div>
              <div><dt>Financial discretion</dt><dd>{view.policy.value.value.financialDiscretion === null ? "Unknown — not recorded" : view.policy.value.value.financialDiscretion}</dd></div>
              <div><dt>Steering</dt><dd>{view.policy.value.value.steering.mode}{view.policy.value.value.steering.instruction === null ? "" : ` · ${view.policy.value.value.steering.instruction}`}</dd></div>
              <div><dt>Exclusions</dt><dd>{view.policy.value.value.exclusions.length ? view.policy.value.value.exclusions.join("; ") : "None recorded"}</dd></div>
              <div><dt>Disclosure</dt><dd>{view.policy.value.value.disclosure}</dd></div>
              <div><dt>Consent</dt><dd>{view.policy.value.value.consent.thirdParty}{view.policy.value.value.consent.immediateOverride === null ? "" : ` · ${view.policy.value.value.consent.immediateOverride}`}</dd></div>
              <div><dt>Review</dt><dd>{view.policy.value.value.reviewAt === null ? "Unknown — no review date recorded" : timestamp(view.policy.value.value.reviewAt.at, view.policy.value.value.reviewAt.timeZone)}</dd></div>
            </dl><p className="needs-you-muted">Ask Kenan in your own conversation to correct or revoke this policy. This view cannot grant authority.</p>
          </>}
      </details>
    </>}
  </section>;
}
