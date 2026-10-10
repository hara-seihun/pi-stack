import type { Bootstrap, ContextEntry, TranscriptItemHead } from "../types";
import { agentMessagePresentation } from "pi-orchestrator/message-format";
import { assertNever } from "../../../shared/explicit-state";
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

export function monoMessage(entry: Pick<ContextEntry, "kind" | "agentSender" | "text" | "inputOrigin">): boolean {
  switch (entry.kind) {
    case "assistant": return true;
    case "user": return entry.inputOrigin === "human" || entry.inputOrigin !== "machine" && !entry.agentSender && (entry.text === undefined || !agentMessagePresentation(entry.text));
    case "system": case "tool": case "thinking": case "toolCall": case "notice": return false;
  }
  return assertNever(entry.kind, "Mono message");
}

export function monoTranscript(heads: readonly TranscriptItemHead[]): TranscriptItemHead[] {
  return heads.filter(head => head.kind !== "assistant" || head.monoVisibility !== "hidden");
}
