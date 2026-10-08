import { Component, useState, type ReactNode } from "react";
import type { UiCase, UiReview } from "./contract";
import { fixtureRequests } from "./transport";
import sourceInventory from "./source-inventory.json";
import nativeCatalogue from "../../../../kenan/native-ui/catalogue.json";
import "./catalogue.css";

const caseModules = import.meta.glob<{ shellCases?: UiCase[]; conversationCases?: UiCase[]; screenCases?: UiCase[]; roomsQuestionsMediaCases?: UiCase[]; envelopeCases?: UiCase[] }>(["./shell.tsx", "./conversation.tsx", "./screens.tsx", "./rooms-questions-media.tsx", "./envelope.tsx"], { eager: true });
const cases = Object.values(caseModules).flatMap(module => module.shellCases ?? module.conversationCases ?? module.screenCases ?? module.roomsQuestionsMediaCases ?? module.envelopeCases ?? []);
const reviewModules = import.meta.glob<{ default: unknown }>("./*-reviews.json", { eager: true });
const remainingModules = import.meta.glob<{ default: unknown }>("./*-remaining.json", { eager: true });
function remainingQueue() {
  return Object.entries(remainingModules).map(([source, module]) => {
    const value = module.default;
    if (!value || typeof value !== "object" || !("scope" in value) || typeof value.scope !== "string" || !("queue" in value) || !Array.isArray(value.queue)) throw new Error(`Invalid remaining UI queue: ${source}`);
    for (const entry of value.queue) {
      if (!entry || typeof entry !== "object" || typeof entry.component !== "string" || typeof entry.next !== "string" || !["finite-variant", "content-boundary", "composition"].includes(entry.boundary) || !Array.isArray(entry.states) || !entry.states.every((state: unknown) => typeof state === "string" && state.length > 0)) throw new Error(`Invalid remaining UI queue entry: ${source}`);
    }
    return { source, scope: value.scope, queue: value.queue };
  });
}

function parseReviews(value: unknown): UiReview[] {
  if (!Array.isArray(value)) throw new Error("UI review receipt must be an array");
  return value.map((row: unknown) => {
    if (!row || typeof row !== "object") throw new Error("UI review receipt must be an object");
    const review = row as Record<string, unknown>;
    for (const key of ["caseId", "evidence", "judgment"]) {
      if (typeof review[key] !== "string" || !review[key].trim()) throw new Error(`UI review ${key} must be nonempty`);
    }
    if (review.additionalEvidence !== undefined && (!Array.isArray(review.additionalEvidence) || !review.additionalEvidence.every((path: unknown) => typeof path === "string" && path.trim().length > 0))) throw new Error("Additional visual evidence must contain nonempty paths");
    if (!["phone", "tablet", "desktop"].includes(String(review.viewport))) throw new Error("Unknown review viewport");
    if (!["light", "dark"].includes(String(review.theme))) throw new Error("Unknown review theme");
    if (!["passed", "fixed", "needs-fix"].includes(String(review.status))) throw new Error("Unknown review status");
    return review as UiReview;
  });
}

const reviews = Object.values(reviewModules).flatMap(module => parseReviews(module.default));
const ids = new Set<string>();
for (const entry of cases) {
  if (ids.has(entry.id)) throw new Error(`Duplicate UI case: ${entry.id}`);
  if (!entry.id || !entry.component || !entry.contract) throw new Error("UI case metadata incomplete");
  ids.add(entry.id);
}
for (const review of reviews) if (!ids.has(review.caseId)) throw new Error(`Review names unregistered case: ${review.caseId}`);

const viewports = ["phone", "tablet", "desktop"] as const;
function coverage() {
  return cases.map(({ render: _render, ...entry }) => ({ ...entry, matrix: viewports.map(viewport => {
    const receipts = reviews.filter(review => review.caseId === entry.id && review.viewport === viewport && review.theme === "dark");
    return { viewport, theme: "dark", status: receipts.length ? receipts[receipts.length - 1].status : "not-yet-viewed", receipts };
  }) }));
}

function report() {
  const matrix = coverage();
  const cells = matrix.flatMap(entry => entry.matrix);
  return {
    sourceRevision: __PI_REMOTE_REVISION__,
    themes: ["dark"],
    scope: "Registered finite UI variants and representative generating classes, not infinite content enumeration or all reachable application states",
    totals: { cases: cases.length, expectedViews: cells.length, viewed: cells.filter(cell => cell.status !== "not-yet-viewed").length,
      passed: cells.filter(cell => cell.status === "passed").length, fixed: cells.filter(cell => cell.status === "fixed").length,
      needsFix: cells.filter(cell => cell.status === "needs-fix").length, notYetViewed: cells.filter(cell => cell.status === "not-yet-viewed").length },
    cases: matrix,
    remainingOwnedReview: remainingQueue(),
    native: nativeCatalogue,
    evidencePolicy: "Receipts record actual historical visual judgments. Source fingerprints identify changed owners for explicit re-review; a newer source revision alone is not a new visual pass.",
    sourceInventory: {
      purpose: "Discovery only: naming a parent component is not evidence that every child branch or union state was rendered or judged",
      components: sourceInventory.components.map(component => ({ ...component,
        namedByCases: cases.filter(entry => entry.component.split(/[ /,]+/).includes(component.name)).map(entry => entry.id),
      })),
      literalContracts: sourceInventory.unions,
      sourceFingerprints: sourceInventory.fingerprints,
      styleFingerprint: sourceInventory.styleFingerprint,
    },
    requests: fixtureRequests,
  };
}

declare global {
  interface Window { PiUiCatalogue: { report: typeof report; cases: Omit<UiCase, "render">[] } }
}
window.PiUiCatalogue = { report, cases: cases.map(({ render: _render, ...entry }) => entry) };

class RenderBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  render() {
    return this.state.error ? <section className="empty-state" role="alert"><strong>Fixture rejected</strong><span>{this.state.error}</span></section> : this.props.children;
  }
}

export function Catalogue({ parameters }: { parameters: URLSearchParams }) {
  const selected = parameters.get("case");
  const entry = selected === null ? null : cases.find(entry => entry.id === selected);
  const [filter, setFilter] = useState("");
  if (selected !== null && !entry) return <section className="empty-state" role="alert"><strong>Unknown UI case</strong><span>{selected}</span><a href="/ui-catalogue.html">Open catalogue</a></section>;
  if (entry && parameters.get("mode") === "render") return <RenderBoundary><div className="ui-fixture" data-ui-case={entry.id}>{entry.render()}</div></RenderBoundary>;
  if (parameters.get("mode") === "report") return <pre className="ui-report">{JSON.stringify(report(), null, 2)}</pre>;
  const visible = cases.filter(entry => `${entry.title} ${entry.component} ${entry.contract}`.toLowerCase().includes(filter.toLowerCase()));
  return <main className="ui-catalogue">
    <header><h1>Pi Stack UI state catalogue</h1><p>Synthetic contract-valid production components. A screenshot counts as viewed only after an agent judges it.</p>
      <p>{report().totals.viewed}/{report().totals.expectedViews} registered viewport cases viewed · <a href="?mode=report">Coverage JSON and source omissions</a></p>
      <p>Registered-case coverage is not whole-product coverage. The report also inventories JSX owners and literal union contracts so unmodelled states remain visible.</p>
      <label>Find a component or state<input value={filter} onChange={event => setFilter(event.target.value)} /></label></header>
    <div className="ui-case-list">{visible.map(entry => <article key={entry.id}><h2><a href={`?case=${encodeURIComponent(entry.id)}&mode=render`}>{entry.title}</a></h2>
      <p>{entry.component} · {entry.boundary}</p><code>{entry.contract}</code>
      <p>{viewports.map(viewport => `${viewport}: ${reviews.filter(review => review.caseId === entry.id && review.viewport === viewport).at(-1)?.status ?? "not-yet-viewed"}`).join(" · ")}</p>
    </article>)}</div>
  </main>;
}
