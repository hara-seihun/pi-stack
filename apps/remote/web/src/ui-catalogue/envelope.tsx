import { useEffect, useState } from "react";
import App from "../App";
import { DismissibleError } from "../dismissible-error";
import { RequestIndicator } from "../RequestIndicator";
import { beginSectionLoad } from "../in-flight";
import { ToastViewport, toast } from "../toasts";
import { installLazyVoice } from "../voice-lazy";
import { revisionOf } from "../../../shared/reconcile";
import { SETTINGS, parseTimezone, type SettingsSnapshot } from "../../../shared/settings";
import type { Bootstrap, Session, StreamSnapshot, StreamWireEvent } from "../../../server/protocol";
import { stateObject, validateSession } from "../../../shared/state-validation";
import type { UiCase } from "./contract";
import { configureFixtureTransport, type FixtureRoute } from "./transport";

const long = "Synthetic delivery failed — 日本語 العربية 🌿. ".repeat(12);
export const appFixtureBootstrap: Bootstrap = { managerOwnerEnvironmentId: "synthetic", manager: { view: "classic", managerThreadId: null, hintSeen: false }, environmentId: "synthetic", home: "/synthetic", threadStarts: [{ id: "personal", label: "Personal", icon: "personal", models: [{ id: "openai/gpt-6.1-sol", label: "Sol", icon: "openai" }] }], speech: null };
export const appFixtureSettings: SettingsSnapshot = { administrator: false, entries: SETTINGS.filter(definition => definition.scope === "person").map(definition => ({ definition, editable: definition.kind !== "owner", value: definition.id === "person.autoCollapse" ? { state: "set", value: true } : { state: "unset" } })) };
const bootstrap = appFixtureBootstrap;
export const appFixtureSettingsRoutes: readonly FixtureRoute[] = [
  { method: "GET", path: "/v1/settings", reply: () => Response.json(appFixtureSettings) },
  { method: "PUT", path: "/v1/settings/person.timezone", reply: async request => {
    const definition = SETTINGS.find(entry => entry.id === "person.timezone");
    if (!definition) throw new Error("Catalogue timezone definition is missing");
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || !("value" in body)) return Response.json({ error: "ui_fixture_invalid_timezone_request" }, { status: 400 });
    const parsed = parseTimezone(body.value, "2026-10-09T00:00:00Z");
    if (!parsed.ok) return Response.json(parsed, { status: 400 });
    return Response.json({ entry: { definition, editable: true, value: { state: "set", value: parsed.value } } });
  } },
];
function full(resource: string, value: StreamSnapshot): StreamWireEvent {
  return { type: "reconcile", resource, revision: revisionOf(value), kind: "full", base: null, value };
}
type AppCaseState = "empty" | "loading" | "failure" | "waiting-close" | "close-failure" | "undo-failure";
function AppFixture({ state }: { state: AppCaseState }) {
  const at = Date.now();
  const root: Session = { id: "ui-root", name: "Synthetic waiting parent", agentName: "Kenan", parentId: null, hasChildren: true, origin: "person", foreground: true,
    model: "openai/gpt-6.1-sol", provider: "openai", cwd: "/synthetic", workspaceName: "Synthetic", environment: "synthetic", state: "waiting", lifecycle: { kind: "waiting", target: "agents", since: at }, held: false, activity: "awaiting", activeTools: [],
    waitingOnAgents: { kind: "agents", threadIds: ["ui-worker"], after: {}, since: at },
    createdAt: new Date(at).toISOString(), updatedAt: new Date(at).toISOString(), revision: 1, idleUnread: false, queuedMessages: [], archivedAt: null };
  const child: Session = { ...root, id: "ui-worker", name: "Synthetic active worker", parentId: root.id, hasChildren: false, foreground: false, state: "running", lifecycle: { kind: "working", phase: "thinking", since: at }, activity: "thinking", waitingOnAgents: undefined };
  validateSession(root); validateSession(child);
  let rows = state === "waiting-close" || state === "close-failure" || state === "undo-failure" ? [root, child] : [];
  let archivedTotal = 0;
  configureFixtureTransport([
    { method: "POST", path: "/v1/reconcile", reply: async request => {
      if (state === "loading") return new Promise<Response>(() => {});
      if (state === "failure") return Response.json({ error: "Synthetic environment disconnected" }, { status: 503 });
      const events: StreamWireEvent[] = [
        { type: "hello", epoch: "synthetic-epoch", streamId: "synthetic-stream", bootstrap },
        full("bootstrap", { type: "bootstrap", bootstrap }),
        full("state", { type: "state", sessions: rows, archivedTotal, ownerErrors: [] }),
        full("workers", { type: "workers", sessions: rows }),
      ];
      const declaration = stateObject(await request.json(), "Synthetic reconciliation declaration");
      if (typeof declaration.session === "string" && declaration.viewing === true) {
        if (!rows.some(row => row.id === declaration.session) || typeof declaration.selectionId !== "string") return Response.json({ error: "ui_fixture_invalid_selection" }, { status: 400 });
        const transcript: StreamSnapshot = { type: "transcript", sessionId: declaration.session, generation: "synthetic-history", total: 0, items: [] };
        const live: StreamSnapshot = { type: "live", sessionId: declaration.session, text: "", thinking: "" };
        events.push(full(`transcript:${declaration.session}`, transcript), full(`live:${declaration.session}`, live));
        events.push({ type: "selection-ready", sessionId: declaration.session, selectionId: declaration.selectionId,
          have: { state: revisionOf({ type: "state", sessions: rows, archivedTotal, ownerErrors: [] }), [`transcript:${declaration.session}`]: revisionOf(transcript), [`live:${declaration.session}`]: revisionOf(live) } });
      }
      return Response.json({ events });
    } },
    { method: "POST", path: "/v1/stream", reply: () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "hello", epoch: "synthetic-epoch", streamId: "synthetic-stream", bootstrap } satisfies StreamWireEvent)}\n\n`)); } }), { headers: { "content-type": "text/event-stream" } }) },
    ...appFixtureSettingsRoutes,
    { method: "GET", path: "/v1/sessions?allAgents=1", reply: () => Response.json({ sessions: rows }) },
    { method: "GET", path: "/v1/notifications", reply: () => Response.json({ cursor: 0, notifications: [] }) },
    { method: "GET", match: url => /^\/v1\/sessions\/ui-(root|worker)\/questions$/.test(url.pathname), reply: () => Response.json({ state: "ready", questions: [] }) },
    { method: "DELETE", path: "/v1/sessions/ui-root", reply: () => {
      if (state === "close-failure") return Response.json({ error: "Synthetic close failed; parent and worker remain visible" }, { status: 503 });
      const archived: Session = { ...root, state: "idle", lifecycle: { kind: "archived" }, activity: "idle", foreground: false, archivedAt: new Date().toISOString(), waitingOnAgents: undefined };
      validateSession(archived); archivedTotal = 1; rows = [child];
      return Response.json({ ok: true, archived: true, session: archived });
    } },
    { method: "POST", path: "/v1/sessions/ui-root/unarchive", reply: () => {
      if (state === "undo-failure") return Response.json({ error: "Synthetic restore failed; retry Undo when the environment returns" }, { status: 503 });
      const reopened: Session = { ...root, state: "idle", lifecycle: { kind: "idle" }, activity: "idle", waitingOnAgents: undefined };
      validateSession(reopened); rows = [reopened, child]; archivedTotal = 0;
      return Response.json({ ok: true, session: reopened });
    } },
    { method: "POST", path: "/v1/feature-usage", reply: () => Response.json({ ok: true }) },
  ]);
  installLazyVoice();
  return <App />;
}
function ErrorFixture({ state }: { state: "plain" | "long" | "pending" | "failed" | "renewed" }) {
  const [generation, setGeneration] = useState(1);
  const [calls, setCalls] = useState(0);
  return <section className="attention-screen"><h2>Delivery feedback</h2><p>Your draft is retained. Dismissal does not retry the failed action.</p>
    <DismissibleError message={state === "long" ? long + "unbroken_".repeat(80) : "Synthetic delivery could not be completed. Retry when the environment reconnects."} resetKey={generation}
      onDismiss={state === "plain" || state === "long" ? undefined : async () => {
        setCalls(value => value + 1);
        if (state === "pending") return new Promise(() => {});
        if (state === "failed") return { ok: false, error: long };
        return { ok: true };
      }} />
    {state === "renewed" && <button className="accent" onClick={() => setGeneration(value => value + 1)}>New error occurrence</button>}
    <p role="status">Dismissal requests: {calls}</p>
  </section>;
}
function IndicatorFixture({ active }: { active: boolean }) {
  const [loading, setLoading] = useState(active);
  useEffect(() => loading ? beginSectionLoad("synthetic-screen-readiness") : undefined, [loading]);
  return <><RequestIndicator /><section className="empty-state"><strong>{loading ? "Loading synthetic screen…" : "Screen ready"}</strong><button className="accent" onClick={() => setLoading(value => !value)}>{loading ? "Finish loading" : "Load again"}</button></section></>;
}
function ToastFixture({ state }: { state: "update" | "undo-error" | "long" }) {
  const [clicked, setClicked] = useState(false);
  const show = () => {
    if (state === "update") toast("Synthetic conversation update", { duration: 30_000, description: "Choose a delivery window before 17:00 UTC.", action: { label: "Open chat", onClick: () => setClicked(true) } });
    else toast.error(state === "undo-error" ? "Could not restore Synthetic review" : long, { duration: 30_000, description: state === "long" ? long : "The owning environment is unavailable. The closed chat remains recoverable.", action: { label: "Retry Undo", onClick: () => setClicked(true) } });
  };
  return <><section className="empty-state"><strong>Notification feedback</strong><button className="accent" onClick={show}>Show synthetic notice</button>{clicked && <span role="status">Action received</span>}</section><ToastViewport scope={`ui-fixture-${state}`} /></>;
}
export const envelopeCases: UiCase[] = [
  ...(["empty", "loading", "failure", "waiting-close", "close-failure", "undo-failure"] as const).map(state => ({ id: `app-${state}`, title: `App envelope · ${state}`, component: "App / RemoteApp", contract: "Real bootstrap/reconciliation and typed waiting parent with active worker; Close removes only the parent, Undo restores it; source pending/failure and action failure are distinct", boundary: "composition" as const, render: () => <AppFixture state={state} /> })),
  ...(["plain", "long", "pending", "failed", "renewed"] as const).map(state => ({ id: `error-${state}`, title: `Dismissible error · ${state}`, component: "DismissibleError", contract: "Actual dismiss state transition; click Dismiss error for pending/failure/renewal; failure retains original message", boundary: state === "long" ? "content-boundary" as const : "finite-variant" as const, render: () => <ErrorFixture state={state} /> })),
  ...([false, true] as const).map(active => ({ id: `readiness-${active ? "loading" : "ready"}`, title: `Readiness · ${active ? "loading" : "ready"}`, component: "RequestIndicator", contract: "Owned section load exists or is explicitly released", boundary: "finite-variant" as const, render: () => <IndicatorFixture active={active} /> })),
  ...(["update", "undo-error", "long"] as const).map(state => ({ id: `toast-${state}`, title: `Toast · ${state}`, component: "ToastViewport", contract: "Actual notice/undo-retry feedback; fixture holds the notice 30 seconds for visual observation; production default remains 3 seconds", boundary: "composition" as const, render: () => <ToastFixture state={state} /> })),
];
