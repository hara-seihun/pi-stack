import type { ThreadStart } from "./types";

export type ThreadCreation = { requestId: string; sessionId: string; destination: string; model: string | null; contextFiles?: string[] };
type Destinations = { kind: "destinations"; starts: ThreadStart[] };
/** `contexts` holds the names of the destination's offered context files the person has checked. */
type Models = { kind: "models"; starts: ThreadStart[]; destination: ThreadStart; origin: number; contexts: string[] };
type Selection = Destinations | Models;
export type ThreadStartState =
  | { kind: "closed" }
  | Selection
  | { kind: "creating"; selection: Selection; request: ThreadCreation }
  | { kind: "failed"; selection: Selection; request: ThreadCreation; error: string };
export type ThreadStartEvent =
  | { type: "open"; starts: ThreadStart[] }
  | { type: "dismiss" }
  | { type: "choose"; stage: string; id: string; origin: number; requestId: string; sessionId: string }
  | { type: "toggleContext"; name: string }
  | { type: "failed"; requestId: string; error: string }
  | { type: "created"; requestId: string }
  | { type: "retry" };

export function threadStartSelection(state: ThreadStartState): Selection | null {
  return state.kind === "closed" ? null : state.kind === "creating" || state.kind === "failed" ? state.selection : state;
}

export function threadStartStage(selection: Selection | null): string {
  return selection?.kind === "models" ? `models:${selection.destination.id}` : "destinations";
}

export function threadStartReducer(state: ThreadStartState, event: ThreadStartEvent): ThreadStartState {
  switch (event.type) {
    case "open":
      return state.kind === "closed" && event.starts.length ? { kind: "destinations", starts: event.starts } : state;
    case "dismiss":
      return { kind: "closed" };
    case "choose": {
      if (state.kind !== "destinations" && state.kind !== "models") return state;
      if (event.stage !== threadStartStage(state)) return state;
      const choice = (state.kind === "models" ? state.destination.models : state.starts).find((choice) => choice.id === event.id);
      if (!choice) return state;
      const destination = state.kind === "destinations" ? state.starts.find((start) => start.id === event.id) : null;
      if (destination?.models.length) {
        return { kind: "models", starts: state.starts, destination, origin: event.origin, contexts: [] };
      }
      return { kind: "creating", selection: state, request: {
        requestId: event.requestId, sessionId: event.sessionId,
        destination: state.kind === "models" ? state.destination.id : choice.id,
        model: state.kind === "models" ? choice.id : null,
        ...(state.kind === "models" && state.destination.contexts?.length ? { contextFiles: state.contexts } : {}),
      } };
    }
    case "toggleContext": {
      if (state.kind !== "models" || !state.destination.contexts?.some((context) => context.name === event.name)) return state;
      const contexts = state.contexts.includes(event.name)
        ? state.contexts.filter((name) => name !== event.name)
        : state.destination.contexts.filter((context) => context.name === event.name || state.contexts.includes(context.name)).map((context) => context.name);
      return { ...state, contexts };
    }
    case "failed":
      return state.kind === "creating" && state.request.requestId === event.requestId ? { ...state, kind: "failed", error: event.error } : state;
    case "created":
      return state.kind === "creating" && state.request.requestId === event.requestId ? { kind: "closed" } : state;
    case "retry":
      return state.kind === "failed" ? { kind: "creating", selection: state.selection, request: state.request } : state;
  }
}
