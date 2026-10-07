import type { Session } from "./types";
import type { ThreadControl } from "../../../../packages/orchestrator/src/threads/contracts";
import { API } from "../../server/api";
import { api } from "./client";

export async function submitThreadControl(command: Extract<ThreadControl, { action: "stop" | "resume" }>) {
  const route = command.action === "stop" ? API.sessionAbort : API.sessionResume;
  await api(route.method, route.path({ sessionId: command.threadId }), command.action === "stop" ? { descendants: false } : {});
}

export function requestStop(session: Session, stop: (id: string, descendants: false) => void) {
  stop(session.id, false);
}
