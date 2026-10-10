import { useEffect, useState } from "react";
import App from "../App";
import { installLazyVoice } from "../voice-lazy";
import { revisionOf } from "../../../shared/reconcile";
import { stateObject, validateSession } from "../../../shared/state-validation";
import type { Session, StreamSnapshot, StreamWireEvent, TranscriptItemBody, TranscriptItemHead } from "../../../server/protocol";
import { appFixtureBootstrap as bootstrap, appFixtureSettingsRoutes } from "./envelope";
import { configureFixtureTransport } from "./transport";
import type { UiCase, UiFixtureActionResult } from "./contract";

type RootMode = "ready" | "pending" | "retained";
const sessionIds: Record<RootMode, string> = { ready: "33333333-3333-4333-8333-333333333333", pending: "44444444-4444-4444-8444-444444444444", retained: "55555555-5555-4555-8555-555555555555" };
const at = Date.parse("2026-10-09T10:00:00Z");
const session: Session = {
  id: sessionIds.ready, name: "Retained synthetic conversation", agentName: "Kenan", parentId: null, hasChildren: false,
  origin: "person", foreground: true, model: "openai/gpt-6.1-sol", provider: "openai", cwd: "/synthetic", workspaceName: "Synthetic", environment: "synthetic",
  state: "idle", lifecycle: { kind: "idle" }, held: false, activity: "idle", activeTools: [], revision: 1, idleUnread: false, queuedMessages: [], archivedAt: null,
  createdAt: new Date(at).toISOString(), updatedAt: new Date(at).toISOString(),
};
validateSession(session);
const bodies: TranscriptItemBody[] = [
  { kind: "user", text: "Keep this conversation readable while its environment reconnects. 日本語 العربية 🌿" },
  { kind: "assistant", text: "The last acknowledged conversation remains here.\n\nYour draft and selected thread should survive a failed refresh; **Reconnect** asks the owning source again." },
];
const items: TranscriptItemHead[] = bodies.map((body, index) => {
  if (body.kind !== "user" && body.kind !== "assistant") throw new Error("Root fixture only accepts complete user/assistant messages");
  return { seq: index, id: revisionOf(body), kind: body.kind, text: body.text, timestamp: at + index * 1000,
    size: new TextEncoder().encode(JSON.stringify(body)).length, ...(index === bodies.length - 1 ? { body } : {}) };
});
function full(resource: string, value: StreamSnapshot): StreamWireEvent {
  return { type: "reconcile", resource, revision: revisionOf(value), kind: "full", base: null, value };
}
type ReadState = "ready" | "pending" | "failed";
type Model = { read: ReadState; pushes: Map<ReadableStreamDefaultController<Uint8Array>, ReturnType<typeof setInterval>> };
const mounted = new Map<string, Model>();
function transition(caseId: string, read: ReadState): UiFixtureActionResult {
  const model = mounted.get(caseId);
  if (!model) return { ok: false, code: "not-mounted", error: "The root composition is not mounted" };
  model.read = read;
  for (const [push, timer] of model.pushes) { clearInterval(timer); push.error(new Error("Synthetic owning environment disconnected")); }
  model.pushes.clear();
  return { ok: true };
}
function RootComposition({ caseId, mode }: { caseId: string; mode: RootMode }) {
  const sessionId = sessionIds[mode];
  const [model] = useState<Model>(() => {
    const selectedSession: Session = { ...session, id: sessionId };
    validateSession(selectedSession);
    const value: Model = { read: mode === "pending" ? "pending" : "ready", pushes: new Map() };
    mounted.set(caseId, value);
    configureFixtureTransport([
      ...appFixtureSettingsRoutes,
      { method: "GET", path: "/v1/notifications", reply: () => Response.json({ cursor: 0, notifications: [] }) },
      { method: "GET", path: `/v1/sessions/${sessionId}/questions`, reply: () => Response.json({ state: "ready", questions: [] }) },
      { method: "GET", path: "/v1/sessions?allAgents=1", reply: () => Response.json({ sessions: [selectedSession] }) },
      { method: "POST", path: "/v1/reconcile", reply: async request => {
        const declaration = stateObject(await request.json(), "Root fixture reconciliation declaration");
        const selected = declaration.session === sessionId && declaration.viewing === true;
        if (selected && value.read === "pending") return new Promise<Response>(() => {});
        if (selected && value.read === "failed") return Response.json({ error: "Synthetic selected source unavailable" }, { status: 503 });
        if (declaration.session !== undefined && declaration.session !== null && declaration.session !== sessionId) return Response.json({ error: "ui_fixture_unknown_thread" }, { status: 400 });
        const state: StreamSnapshot = { type: "state", sessions: [selectedSession], archivedTotal: 0, ownerErrors: [] };
        const events: StreamWireEvent[] = [{ type: "hello", epoch: "synthetic-root", streamId: "synthetic-push", bootstrap }, full("bootstrap", { type: "bootstrap", bootstrap }), full("state", state), full("workers", { type: "workers", sessions: [selectedSession] })];
        if (selected) {
          if (typeof declaration.selectionId !== "string") return Response.json({ error: "ui_fixture_selection_identity_missing" }, { status: 400 });
          const transcript: StreamSnapshot = { type: "transcript", sessionId, generation: "synthetic-retained-history", total: items.length, items };
          const live: StreamSnapshot = { type: "live", sessionId, text: "", thinking: "" };
          events.push(full(`transcript:${sessionId}`, transcript), full(`live:${sessionId}`, live), full(`questions:${sessionId}`, { type: "questions", sessionId, state: "ready", questions: [] }));
          events.push({ type: "selection-ready", sessionId, selectionId: declaration.selectionId, have: { state: revisionOf(state), [`transcript:${sessionId}`]: revisionOf(transcript), [`live:${sessionId}`]: revisionOf(live) } });
        }
        return Response.json({ events });
      } },
      { method: "POST", path: "/v1/stream", reply: () => {
        let push: ReadableStreamDefaultController<Uint8Array>;
        let keepAlive: ReturnType<typeof setInterval>;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            push = controller;
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "hello", epoch: "synthetic-root", streamId: "synthetic-push", bootstrap } satisfies StreamWireEvent)}\n\n`));
            keepAlive = setInterval(() => controller.enqueue(new TextEncoder().encode(": synthetic liveness\n\n")), 10_000);
            value.pushes.set(controller, keepAlive);
          },
          cancel() { value.pushes.delete(push); clearInterval(keepAlive); },
        }), { headers: { "content-type": "text/event-stream" } });
      } },
      { method: "POST", path: "/v1/feature-usage", reply: () => Response.json({ ok: true }) },
    ]);
    installLazyVoice();
    return value;
  });
  useEffect(() => () => { mounted.delete(caseId); for (const [push, timer] of model.pushes) { clearInterval(timer); push.close(); } model.pushes.clear(); }, [caseId, model]);
  return <App />;
}
export const appCompositionCases: UiCase[] = [
  ...(["ready", "pending", "retained"] as const).map(mode => {
    const id = `app-selected-${mode}`;
    return { id, title: `Root selected conversation · ${mode}`, component: "App RemoteApp ConversationScreen Shell", boundary: "composition" as const,
      contract: "Click the real inbox row; ready/pending selection is distinct. Retained case: fixture disconnect action fails the source, repaired action restores source availability, actual Reconnect clears the failed refresh without changing selection/draft.",
      render: () => <RootComposition caseId={id} mode={mode} />,
      actions: [{ id: "disconnect", label: "Make the synthetic selected source unavailable", run: () => transition(id, "failed") }, { id: "repair", label: "Restore the synthetic selected source", run: () => transition(id, "ready") }],
    };
  }),
];
