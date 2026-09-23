import type { Session } from "../../../../server/protocol";

export type WorkerNode = {
  session: Session;
  children: WorkerNode[];
  depth: number;
  activeDescendants: number;
};

export function isActiveWorker(session: Session): boolean {
  return session.state === "running" || session.activity === "awaiting";
}

export type WorkerFilter = "active" | "all";

/**
 * Active keeps what is working, whatever is above it, and the direct workers of
 * anything working: a thinking orchestrator's settled subagents are the work it
 * is thinking about, so hiding them made a busy parent look like it had none.
 */
export function visibleWorker(node: WorkerNode, filter: WorkerFilter, parentActive = false): boolean {
  return filter === "all" || parentActive || isActiveWorker(node.session) || node.activeDescendants > 0;
}

function updatedAt(session: Session): number {
  const value = Date.parse(session.updatedAt);
  return Number.isFinite(value) ? value : 0;
}

function compareWorkers(left: Session, right: Session): number {
  const active = Number(isActiveWorker(right)) - Number(isActiveWorker(left));
  return active || updatedAt(right) - updatedAt(left) || left.id.localeCompare(right.id);
}

export function buildWorkerTree(sessions: Session[]): WorkerNode[] {
  const byId = new Map<string, WorkerNode>(sessions.map(session => [session.id, { session, children: [], depth: 0, activeDescendants: 0 }]));
  const roots: WorkerNode[] = [];

  for (const node of byId.values()) {
    const parent = node.session.parentId ? byId.get(node.session.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const arrange = (node: WorkerNode, depth: number): number => {
    node.depth = depth;
    node.children.sort((left, right) => compareWorkers(left.session, right.session));
    node.activeDescendants = node.children.reduce((count, child) => count + arrange(child, depth + 1), 0);
    return node.activeDescendants + Number(isActiveWorker(node.session));
  };

  roots.sort((left, right) => {
    const origin = Number(right.session.origin === "person") - Number(left.session.origin === "person");
    return origin || compareWorkers(left.session, right.session);
  });
  roots.forEach(node => arrange(node, 0));
  return roots;
}
