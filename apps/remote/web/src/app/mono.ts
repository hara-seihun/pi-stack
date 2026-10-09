import type { Bootstrap, TranscriptItemHead } from "../types";
import { routeThreadId, type Route } from "./routes";

export type ManagerPreference = NonNullable<Bootstrap["manager"]>;

export function managerNavigation(previous: ManagerPreference | null, next: ManagerPreference, route: Route): Route | null {
  if (next.view === "mono") {
    if (previous?.view === "mono" && previous.managerThreadId === next.managerThreadId) return null;
    if (previous === null && routeThreadId(route) !== null) return null;
    return { tab: "chats", chat: `ai:${next.managerThreadId}`, panel: null };
  }
  if (previous?.view === "mono") return { tab: "chats", chat: null, panel: null };
  return null;
}

export function monoTranscript(heads: readonly TranscriptItemHead[]): TranscriptItemHead[] {
  return heads.filter(head => head.monoVisibility !== "hidden");
}
