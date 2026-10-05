import { useEffect, useRef } from "react";
import type { Session } from "./types";
import type { ThreadControl } from "../../../../packages/orchestrator/src/threads/contracts";
import { API } from "../../server/api";
import { api } from "./client";

export async function submitThreadControl(command: Extract<ThreadControl, { action: "stop" | "resume" }>) {
  const route = command.action === "stop" ? API.sessionAbort : API.sessionResume;
  await api(route.method, route.path({ sessionId: command.threadId }), command.action === "stop" ? { descendants: command.descendants } : {});
}

export function requestStop(session: Session, stop: (id: string, descendants: false) => void) {
  stop(session.id, false);
}

/** Workers below a thread that are working right now; closing the thread would cancel them. */
export function runningDescendants(threadId: string, sessions: readonly Session[]): Session[] {
  const children = new Map<string, Session[]>();
  for (const session of sessions) if (session.parentId && !session.archivedAt) children.set(session.parentId, [...children.get(session.parentId) ?? [], session]);
  const running: Session[] = [], seen = new Set([threadId]), queue = [threadId];
  for (const id of queue) for (const child of children.get(id) ?? []) {
    if (seen.has(child.id)) continue;
    seen.add(child.id); queue.push(child.id);
    if (child.state === "running" && !child.held) running.push(child);
  }
  return running;
}

export function CloseRunningChatDialog({ title, running, onConfirm, onClose }: {
  title: string;
  running: number;
  onConfirm(): void;
  onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  const workers = running === 1 ? "1 worker is" : `${running} workers are`;
  return <dialog ref={dialog} className="stop-thread-dialog" aria-labelledby="close-running-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    <h2 id="close-running-title">Close a chat with running workers?</h2>
    <p>{title}: {workers} still working. Closing stops them; Undo restores the chat and its workers and continues their work.</p>
    <div className="stop-choices">
      <button type="button" onClick={onConfirm}>Close and stop workers</button>
      <button type="button" autoFocus onClick={onClose}>Keep open</button>
    </div>
  </dialog>;
}
