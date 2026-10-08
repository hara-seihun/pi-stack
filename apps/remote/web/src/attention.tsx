import { useEffect, useRef, useState, type ReactNode } from "react";
import { API } from "../../server/api";
import type { CalendarEvent } from "../../server/calendar-protocol";
import type { NotificationHistory } from "../../server/protocol";
import type { NeedsYouProjection } from "../../shared/needs-you";
import { piFetch } from "./client";
import { CalendarScreen } from "./calendar";
import { NeedsYouCard, NeedsYouDetails } from "./needs-you";
import { NotificationCard } from "./features/notifications/NotificationCard";
import { attentionFeed, type AttentionItem } from "./attention-model";
import { assertNever } from "../../shared/explicit-state";
import "./attention.css";

type Resource<T> =
  | { state: "loading"; value: T | null }
  | { state: "ready"; value: T }
  | { state: "failed"; value: T | null; error: string };
async function load<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await piFetch(path, { method: "GET", signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]), cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
function useNeeds(version: number, attempt: number) {
  const [resource, setResource] = useState<Resource<NeedsYouProjection>>({ state: "loading", value: null });
  useEffect(() => {
    const controller = new AbortController();
    setResource(current => ({ state: "loading", value: current.value }));
    void load<NeedsYouProjection>(API.needsYou.path(), controller.signal).then(value => {
      if (!controller.signal.aborted) setResource({ state: "ready", value });
    }, error => {
      if (!controller.signal.aborted) setResource(current => ({ state: "failed", value: current.value, error: String(error) }));
    });
    return () => controller.abort();
  }, [version, attempt]);
  return resource;
}
function useNotifications(version: number, attempt: number) {
  const [resource, setResource] = useState<Resource<NotificationHistory>>({ state: "loading", value: null });
  const requests = useRef(new Set<AbortController>());
  const generation = useRef(0);
  useEffect(() => {
    const revision = ++generation.current, controller = new AbortController();
    requests.current.add(controller);
    setResource(current => ({ state: "loading", value: current.value }));
    void load<NotificationHistory>(`${API.notifications.path()}?history=1`, controller.signal).then(value => {
      if (!controller.signal.aborted && generation.current === revision) setResource({ state: "ready", value });
    }, error => {
      if (!controller.signal.aborted && generation.current === revision) setResource(current => ({ state: "failed", value: current.value, error: String(error) }));
    }).finally(() => requests.current.delete(controller));
    return () => { for (const request of requests.current) request.abort(); requests.current.clear(); };
  }, [version, attempt]);
  function earlier() {
    if (resource.state === "loading" || resource.value === null || resource.value.before === null) return;
    const revision = generation.current, before = resource.value.before, controller = new AbortController();
    requests.current.add(controller);
    setResource(current => ({ state: "loading", value: current.value }));
    void load<NotificationHistory>(`${API.notifications.path()}?history=1&before=${before}`, controller.signal).then(value => {
      if (!controller.signal.aborted && generation.current === revision) setResource(current => ({ state: "ready", value: { before: value.before, notifications: [...(current.value === null ? [] : current.value.notifications), ...value.notifications] } }));
    }, error => {
      if (!controller.signal.aborted && generation.current === revision) setResource(current => ({ state: "failed", value: current.value, error: String(error) }));
    }).finally(() => requests.current.delete(controller));
  }
  return { resource, earlier };
}
function ResourceStatus({ label, resource }: { label: string; resource: Resource<unknown> }) {
  switch (resource.state) {
    case "ready": return null;
    case "loading": return <p className="attention-muted" role="status">{resource.value === null ? `Loading ${label}…` : `Refreshing ${label}…`}</p>;
    case "failed": return <p className="attention-error" role="alert">Could not load {label}: {resource.error}.{resource.value !== null && " Last loaded items are still shown."}</p>;
  }
  return assertNever(resource, "Attention resource");
}
export function AttentionScreen({ version }: { version: number }) {
  const [attempt, refresh] = useState(0);
  const needs = useNeeds(version, attempt), notifications = useNotifications(version, attempt);
  const view = needs.value;
  function agenda(events: CalendarEvent[], renderEvent: (event: CalendarEvent) => ReactNode, zone: string) {
    const feed = attentionFeed(view === null ? [] : view.items, notifications.resource.value === null ? [] : notifications.resource.value.notifications, events, zone, Date.now());
    function card(item: AttentionItem) {
      switch (item.kind) {
        case "need": return <NeedsYouCard item={item.value} />;
        case "update": return <NotificationCard item={item.value} />;
        case "event": return renderEvent(item.value);
      }
      return assertNever(item, "Attention item");
    }
    return <>
      <section aria-label="Now"><h2>Now</h2>{feed.now.length ? <ol className="attention-feed">{feed.now.map(item => <li key={item.id}>{card(item)}</li>)}</ol> : <p className="attention-muted">Nothing due now in the loaded sources.</p>}</section>
      <section aria-label="Upcoming"><h2>Upcoming</h2>{feed.upcoming.length ? <ol className="attention-feed">{feed.upcoming.map(item => <li key={item.id}>{card(item)}</li>)}</ol> : <p className="attention-muted">No upcoming items in the loaded sources.</p>}</section>
      <details className="attention-history"><summary>History · {feed.history.length}</summary><ol className="attention-feed">{feed.history.map(item => <li key={item.id}>{card(item)}</li>)}</ol></details>
      {notifications.resource.value?.before != null && <button type="button" disabled={notifications.resource.state === "loading"} onClick={notifications.earlier}>Load earlier updates</button>}
    </>;
  }
  return <section className="attention-screen" aria-label="Attention">
    <header className="attention-header"><div><h1>Attention</h1><p>What needs you, what changed, and what's coming up.</p></div><button type="button" disabled={needs.state === "loading" || notifications.resource.state === "loading"} onClick={() => refresh(value => value + 1)}>Refresh</button></header>
    <ResourceStatus label="decisions and questions" resource={needs} /><ResourceStatus label="updates" resource={notifications.resource} />
    {view?.life.state === "failed" && <p className="attention-error" role="alert">Life model unavailable: {view.life.error}. Questions still come from their original owners.</p>}
    {view?.questions.state === "partial" && <details className="attention-error"><summary>Some question sources are unavailable</summary><ul>{view.questions.errors.map((error, index) => <li key={index}>{error}</li>)}</ul></details>}
    <CalendarScreen refreshVersion={`${version}:${attempt}`} renderAgenda={({ events, renderEvent, zone }) => agenda(events, renderEvent, zone)} />
    {view && <details className="attention-coverage"><summary>Coverage and delegation</summary><NeedsYouDetails view={view} /></details>}
  </section>;
}
