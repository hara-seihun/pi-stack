import { Component, useState, type ReactNode } from "react";
import type { UiCase, UiFixtureActionResult } from "./contract";
import { fixtureRequests } from "./transport";
import "./catalogue.css";

const modules = import.meta.glob<{ shellCases?: UiCase[]; conversationCases?: UiCase[]; screenCases?: UiCase[]; roomsQuestionsMediaCases?: UiCase[]; envelopeCases?: UiCase[]; appCompositionCases?: UiCase[] }>(["./shell.tsx", "./conversation.tsx", "./screens.tsx", "./rooms-questions-media.tsx", "./envelope.tsx", "./app-compositions.tsx"], { eager: true });
const cases = Object.values(modules).flatMap(module => module.shellCases ?? module.conversationCases ?? module.screenCases ?? module.roomsQuestionsMediaCases ?? module.envelopeCases ?? module.appCompositionCases ?? []);
const ids = new Set<string>();
for (const entry of cases) {
  if (!entry.id || !entry.component || !entry.contract || ids.has(entry.id)) throw new Error(`Invalid UI fixture: ${entry.id}`);
  ids.add(entry.id);
}
const metadata = cases.map(({ render: _render, ...entry }) => entry);
function report() { return { sourceRevision: __PI_REMOTE_REVISION__, cases: metadata, requests: fixtureRequests }; }
function invokeAction(caseId: string, actionId: string): UiFixtureActionResult {
  const entry = cases.find(entry => entry.id === caseId);
  if (!entry) return { ok: false, code: "unknown-case", error: `Unknown case: ${caseId}` };
  if (new URLSearchParams(location.search).get("case") !== caseId) return { ok: false, code: "not-mounted", error: "Open this case before invoking its fixture action" };
  const action = entry.actions?.find(action => action.id === actionId);
  return action ? action.run() : { ok: false, code: "unknown-action", error: `Unknown fixture action: ${actionId}` };
}
declare global {
  interface Window { PiUiCatalogue: { report: typeof report; cases: Omit<UiCase, "render">[]; invokeAction: typeof invokeAction } }
}
window.PiUiCatalogue = { report, invokeAction, cases: metadata };
class RenderBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  render() { return this.state.error ? <section className="empty-state" role="alert"><strong>Fixture rejected</strong><span>{this.state.error}</span></section> : this.props.children; }
}
export function Catalogue({ parameters }: { parameters: URLSearchParams }) {
  const selected = parameters.get("case");
  const entry = selected === null ? null : cases.find(entry => entry.id === selected);
  const [filter, setFilter] = useState("");
  if (selected !== null && !entry) return <section className="empty-state" role="alert"><strong>Unknown UI case</strong><span>{selected}</span><a href="./ui-catalogue.html">Open workbench</a></section>;
  if (entry && parameters.get("mode") === "render") return <RenderBoundary><div className="ui-fixture" data-ui-case={entry.id}>{entry.render()}</div></RenderBoundary>;
  if (parameters.get("mode") === "report") return <pre className="ui-report">{JSON.stringify(report(), null, 2)}</pre>;
  const visible = cases.filter(entry => `${entry.title} ${entry.component} ${entry.contract}`.toLowerCase().includes(filter.toLowerCase()));
  return <main className="ui-catalogue"><header><h1>Pi Stack fixture workbench</h1><label>Find a component or state<input value={filter} onChange={event => setFilter(event.target.value)} /></label></header>
    <div className="ui-case-list">{visible.map(entry => <article key={entry.id}><h2><a href={`?case=${encodeURIComponent(entry.id)}&mode=render`}>{entry.title}</a></h2><p>{entry.component} · {entry.boundary}</p><code>{entry.contract}</code></article>)}</div>
  </main>;
}
