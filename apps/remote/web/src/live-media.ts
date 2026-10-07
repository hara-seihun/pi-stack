const sessions = new Set<symbol>();
let installing = false;
const listeners = new Set<() => void>();
export const liveMediaActive = () => sessions.size > 0;
export function subscribeLiveMedia(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function holdLiveMedia(): () => void {
  if (installing) throw new Error("An app update is applying. Start the call after it finishes.");
  const session = Symbol();
  sessions.add(session);
  return () => {
    if (!sessions.delete(session) || sessions.size) return;
    for (const listener of listeners) listener();
  };
}

export function beginAppUpdate(): (() => void) | null {
  if (sessions.size || installing) return null;
  installing = true;
  return () => { installing = false; };
}
