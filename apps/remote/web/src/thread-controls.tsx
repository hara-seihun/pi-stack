import { useEffect, useRef } from "react";
import type { Session } from "./types";
import type { ThreadControl } from "../../../../packages/orchestrator/src/threads/contracts";
import { API } from "../../server/api";
import { api } from "./client";
import { DismissibleError } from "./dismissible-error";

export async function submitThreadControl(command: Extract<ThreadControl, { action: "stop" | "resume" }>) {
  const route = command.action === "stop" ? API.sessionAbort : API.sessionResume;
  await api(route.method, route.path({ sessionId: command.threadId }), command.action === "stop" ? { descendants: command.descendants } : {});
}

export function requestStop(session: Session, stop: (id: string, descendants: boolean) => void, choose: (session: Session) => void) {
  if (session.hasChildren) choose(session);
  else stop(session.id, false);
}

export function StopChoices({ pending, onStop }: { pending: boolean; onStop(descendants: boolean): void }) {
  return <div className="stop-choices">
    <button type="button" disabled={pending} onClick={() => onStop(true)}>Yes, stop subthreads</button>
    <button type="button" disabled={pending} onClick={() => onStop(false)}>No, just stop this thread</button>
  </div>;
}

export function ThreadStopDialog({ session, pending, error, onStop, onClose }: {
  session: Session;
  pending: boolean;
  error: string;
  onStop(descendants: boolean): void;
  onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  return <dialog ref={dialog} className="stop-thread-dialog" aria-labelledby="stop-thread-title" onCancel={event => { event.preventDefault(); if (!pending) onClose(); }}>
    <h2 id="stop-thread-title">Should the subthreads stop too?</h2>
    <p>{session.name}</p>
    <DismissibleError message={error} resetKey={session.id} dismissLabel="Dismiss stop error" />
    <StopChoices pending={pending} onStop={onStop} />
    <button type="button" disabled={pending} onClick={onClose}>Cancel</button>
  </dialog>;
}
