import { useState, type ReactNode } from "react";
import { useVisibleSelection } from "../../app/use-visible-selection";
import { StatusPill } from "../status/StatusPill";
import { threadStatus } from "../status/thread-status";
import { ModelGlyph } from "../status/model-glyph";
import type { Session } from "../../../../server/protocol";
import { buildWorkerTree, isActiveWorker, visibleWorker as visible, type WorkerNode } from "./tree-model";
import "./workers.css";

export type WorkersTreeProps = {
  sessions: Session[];
  selectedId: string | null;
  filter: "active" | "all";
  onFilter(filter: "active" | "all"): void;
  onOpen(session: Session): void;
  /** Called on the press, before the open: the thread's transcript is worth having early. */
  onPrefetch?(session: Session): void;
  /** Embedded inside another view: no filter chips or origin groups. */
  compact?: boolean;
  /** The detail header owns metadata for the selected desktop row. */
  compactSelected?: boolean;
  onSelectedVisibleChange?(visible: boolean): void;
};

function relativeTime(value: string): string {
  const milliseconds = Date.now() - Date.parse(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 60_000) return "now";
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  if (hours < 48) return "yesterday";
  return `${Math.floor(hours / 24)}d`;
}

export function WorkersTree({ sessions, selectedId, filter, onFilter, onOpen, onPrefetch, compact = false, compactSelected = false, onSelectedVisibleChange }: WorkersTreeProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const roots = buildWorkerTree(sessions);
  const selectionRoot = useVisibleSelection(".worker-row.selected .worker-name", roots, onSelectedVisibleChange);
  const renderNode = (node: WorkerNode, parentActive = false): ReactNode => {
    if (!visible(node, filter, parentActive)) return null;
    const active = isActiveWorker(node.session);
    const children = node.children.filter(child => visible(child, filter, active));
    const hasChildren = children.length > 0;
    const isCollapsed = collapsed.has(node.session.id);
    const titleOnly = compactSelected && selectedId === node.session.id;
    return <li key={node.session.id} className="worker-node">
      <div className={`worker-row${selectedId === node.session.id ? " selected" : ""}${titleOnly ? " title-only" : ""}`} style={{ paddingInlineStart: `calc(var(--space-2) + ${node.depth} * var(--space-5))` }}>
        {hasChildren ? <button className="worker-disclosure" type="button" aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${node.session.name}`} aria-expanded={!isCollapsed} onClick={() => setCollapsed(current => {
          const next = new Set(current); if (next.has(node.session.id)) next.delete(node.session.id); else next.add(node.session.id); return next;
        })}><svg viewBox="0 0 24 24" aria-hidden="true"><path d={isCollapsed ? "m9 18 6-6-6-6" : "m18 9-6 6-6-6"} /></svg></button> : <span className="worker-disclosure-placeholder" />}
        <button className="worker-open" type="button" onClick={() => onOpen(node.session)} onPointerDown={() => onPrefetch?.(node.session)}>
          {!titleOnly && <ModelGlyph model={node.session.model} className="worker-model-icon" />}
          <span className="worker-name">{node.session.name}</span>
          {!titleOnly && <StatusPill status={threadStatus(node.session)} compact />}
          {!titleOnly && <time className="worker-time" dateTime={node.session.updatedAt}>{relativeTime(node.session.updatedAt)}</time>}
          {!titleOnly && hasChildren && isCollapsed && <span className="worker-children" aria-label={`${children.length} ${children.length === 1 ? "worker" : "workers"}`} title={`${children.length} ${children.length === 1 ? "worker" : "workers"}`}>{children.length}</span>}
        </button>
      </div>
      {hasChildren && !isCollapsed && <ul className="worker-children-list">{children.map(child => renderNode(child, active))}</ul>}
    </li>;
  };
  const yours = roots.filter(node => node.session.origin === "person");
  const fleet = roots.filter(node => node.session.origin === "fleet");
  if (compact) return <section ref={selectionRoot} className="workers-tree compact" aria-label="Workers"><ul>{roots.map(node => renderNode(node))}</ul></section>;
  return <section ref={selectionRoot} className="workers-tree" aria-label="Workers">
    <div className="worker-filters" role="group" aria-label="Worker filter">
      {(["active", "all"] as const).map(value => <button key={value} className={filter === value ? "active" : ""} type="button" aria-pressed={filter === value} onClick={() => onFilter(value)}>{value === "active" ? "Active" : "All"}</button>)}
    </div>
    {([ ["Yours", yours], ["Fleet", fleet] ] as const).map(([label, nodes]) => nodes.some(node => visible(node, filter)) && <section className="worker-group" key={label}><h2>{label}</h2><ul>{nodes.map(node => renderNode(node))}</ul></section>)}
    {!roots.some(node => visible(node, filter)) && <p className="worker-empty">{filter === "active" ? "No workers are running." : "No workers yet. Threads that spawn workers appear here with their children."}</p>}
  </section>;
}
