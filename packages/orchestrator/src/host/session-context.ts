/**
 * Process-local ancestry for embedded sessions.
 *
 * A delegated session is a real Pi session, but it is not a second fleet slot
 * or an independent interactive lease. Extensions consult this registry at
 * session events so a child inherits its parent's already-made account choice.
 */
export interface NestedSessionContext {
  readonly parentSessionId: string;
  readonly rootSessionId: string;
}

const contexts: Map<string, NestedSessionContext> =
  ((globalThis as any).__piOrchestratorNestedSessions ??= new Map());

export function nestedSession(sessionId: string): NestedSessionContext | undefined {
  return contexts.get(sessionId);
}

export function registerNestedSession(
  sessionId: string,
  parentSessionId: string,
): () => void {
  const rootSessionId = contexts.get(parentSessionId)?.rootSessionId ?? parentSessionId;
  contexts.set(sessionId, { parentSessionId, rootSessionId });
  return () => contexts.delete(sessionId);
}
