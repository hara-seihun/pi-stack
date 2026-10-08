import type { LifeCoverage } from "kenan-memory/life-contract";
import type { NeedsYouDismissal, NeedsYouDismissResult, NeedsYouItem, NeedsYouProjection } from "../../shared/needs-you";
import { API } from "../../server/api";
import { piFetch } from "./client";
import { formatRoute } from "./app/routes";
import "./needs-you.css";

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

type DismissNeedResult = { ok: true } | Pick<Extract<NeedsYouDismissResult, { ok: false }>, "ok" | "message" | "questionDismissed">;
export async function dismissNeed(dismissal: NeedsYouDismissal): Promise<DismissNeedResult> {
  try {
    const response = await piFetch(API.dismissNeed.path(), {
      method: "POST", headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(dismissal), signal: AbortSignal.timeout(20_000), cache: "no-store",
    });
    const result: unknown = await response.json();
    if (typeof result === "object" && result !== null && "ok" in result) {
      if (result.ok === true && response.ok) return { ok: true };
      if (result.ok === false && "error" in result && typeof result.error === "string" && "message" in result && typeof result.message === "string") {
        if (!("questionDismissed" in result)) return { ok: false, message: result.message };
        if (result.questionDismissed === true) return { ok: false, message: result.message, questionDismissed: true };
      }
    }
    return { ok: false, message: `Dismissal returned an invalid response (HTTP ${response.status}). Refresh before trying again.` };
  } catch (error) {
    return { ok: false, message: `${error instanceof Error ? error.message : String(error)}. Dismissal was not confirmed; refresh before trying again.` };
  }
}

export function NeedsYouCard({ item, busy, onDismiss }: { item: NeedsYouItem; busy: boolean; onDismiss: (item: NeedsYouItem) => void }) {
  const action = item.nextAction !== null ? item.nextAction : item.recommendation;
  const recommendation = item.recommendation !== action ? item.recommendation : null;
  return <article className="attention-decision" aria-busy={busy}>
    <div className="attention-card-meta"><span>{labels[item.kind]}</span>{item.deadline !== null && <time dateTime={item.deadline.at}>{timestamp(item.deadline.at, item.deadline.timeZone)}</time>}</div>
    <h3>{item.title}</h3>
    {action !== null && action !== item.title && <p className="attention-card-body">{action}</p>}
    <div className="attention-card-footer"><div className="needs-you-actions">
      {item.location !== null && <a className="needs-you-open" aria-label={item.location.questionId !== null ? "Answer in original conversation" : "Open source conversation"} href={formatRoute({ tab: "chats", chat: `ai:${item.location.threadId}`, panel: null, ...(item.location.questionId === null ? {} : { questionId: item.location.questionId }) })}>{item.location.questionId !== null ? "Answer" : "Open conversation"}</a>}
      <button type="button" disabled={busy} title={item.dismissal.kind === "commitment" ? "Hides this reminder; does not cancel your commitment." : undefined} onClick={() => { if (!busy) onDismiss(item); }}>{busy ? "Dismissing…" : item.dismissal.kind === "commitment" ? "Dismiss reminder" : "Dismiss"}</button>
    </div>
    {(item.consequence !== null || recommendation !== null) && <details className="attention-card-details"><summary>Details</summary><dl>
      {item.consequence !== null && <div><dt>Consequence</dt><dd>{item.consequence}</dd></div>}
      {recommendation !== null && <div><dt>Kenan recommends</dt><dd>{recommendation}</dd></div>}
    </dl></details>}</div>
  </article>;
}

export function NeedsYouDetails({ view }: { view: NeedsYouProjection }) {
  return <div className="attention-details">
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
  </div>;
}
